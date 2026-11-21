// Grok starts one MCP process per session. Its command hooks carry the prompt ID absent from tools/call.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APPROVAL_TIMEOUT_MS, isMainModule, nativeAppApprovalOptions, nativeAppApprovalResponse, nativeApprovalForm,
} from './client.mjs';
import { askRelays, controlDirectory, runHookRelay } from './hook-relay.mjs';

const directory = () => controlDirectory('grok', 'LCU_GROK_CONTROL_DIR');
const events = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'StopCancelled', 'SessionEnd', 'Notification']);
const APPROVAL_REASON = 'Grok could not show the approval prompt';
/** A cancelled approval answered sooner than this was never shown to a person. */
export const UNSHOWN_CANCEL_MS = 250;

// The first prompt hook can run before the MCP process listens, so each prompt leaves a private marker. Host PID
// isolates resumed sessions. Grok's hook guide: a queued prompt starts only after the previous turn ends; a
// cancel-and-send, a rewind or a superseded turn sends no end report; a cancelled turn's report can arrive after the
// next UserPromptSubmit; the `idle_prompt` notification settles turns that reported nothing; and events carrying
// `subagentType` belong to a subagent, not to the session. So the newest prompt replaces every older marker.
const hash = value => createHash('sha256').update(value).digest('hex');
const promptDirectory = (sessionId, hostPid) => join(directory(), `turns-${hostPid}-${hash(sessionId)}`);
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('Unsafe Grok turn directory.');
  chmodSync(path, 0o700);
}
function markers(path) {
  try {
    return readdirSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
/** The session's one current prompt, or undefined. */
function currentPrompt(path) {
  const ids = path ? markers(path) : [];
  if (ids.length !== 1) return undefined;
  try {
    const prompt = readFileSync(join(path, ids[0]), 'utf8');
    return prompt && hash(prompt) === ids[0] ? prompt : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function runHook() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const { hook_event_name: event, sessionId, promptId, subagentType } = input;
  if (!events.has(event) || typeof sessionId !== 'string' || !sessionId || subagentType) return;
  privateDirectory(directory());
  const path = promptDirectory(sessionId, process.ppid);
  const request = { event, sessionId };
  if (event === 'SessionEnd') {
    rmSync(path, { recursive: true, force: true });
  } else if (event === 'Notification') {
    if ((input.notificationType ?? input.notification_type) !== 'idle_prompt') return;
    // The ping is stamped when it is dispatched; a prompt submitted after that keeps its marker.
    const dispatched = Date.parse(input.timestamp);
    if (!Number.isFinite(dispatched)) return;
    for (const name of markers(path)) {
      try {
        if (lstatSync(join(path, name)).mtimeMs < dispatched) rmSync(join(path, name), { force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  } else {
    if (typeof promptId !== 'string' || !promptId) return;
    request.promptId = promptId;
    const marker = hash(promptId);
    if (event === 'UserPromptSubmit') {
      privateDirectory(path);
      for (const name of markers(path)) if (name !== marker) rmSync(join(path, name), { force: true });
      writeFileSync(join(path, marker), promptId, { mode: 0o600 });
    } else {
      rmSync(join(path, marker), { force: true });
    }
  }
  await askRelays(request, {
    directory: directory(), parent: process.ppid, ancestors: 1, timeoutSeconds: 10,
  });
}

async function runRelay(command) {
  const sessionId = process.env.GROK_SESSION_ID;
  privateDirectory(directory());
  return runHookRelay({
    command, cwd: process.cwd(), name: 'grok', host: 'Grok', approvalReason: APPROVAL_REASON, directory: directory(),
    harness(relay) {
      const path = sessionId && promptDirectory(sessionId, process.ppid);
      // Grok includes the MCP initialization instructions in the model's first request.
      if (sessionId) relay.stateOf(sessionId).told = true;
      return {
        sessionOf: () => sessionId,
        turnIdOf() {
          const prompt = currentPrompt(path);
          if (prompt) return prompt;
          throw new Error('LCU needs one active Grok prompt. Check folder trust and the LCU hooks, then retry.');
        },
        async onHook({ event, sessionId: owner, promptId }) {
          if (owner !== sessionId || !owner || !events.has(event)) return {};
          const state = relay.sessions.get(owner);
          const active = state?.active?.turnId;
          if (event === 'UserPromptSubmit' || event === 'Notification') {
            // A newer prompt or an idle session settles an open turn that sent no end report. The prompt hook
            // gates the prompt, so it does not wait; a failed end stays pending for the next call.
            if (active === undefined || active === currentPrompt(path)) return {};
            const ending = relay.finish(owner, 'Interrupt');
            if (event === 'UserPromptSubmit') ending.catch(() => {});
            else await ending;
          } else if (event === 'SessionEnd') {
            await relay.finish(owner, 'Interrupt');
          } else if (promptId && (active === promptId || state?.pending?.turnId === promptId)) {
            // A delayed end report must only release the turn named in it.
            await relay.finish(owner, event === 'Stop' ? 'Stop' : 'Interrupt');
          }
          return {};
        },
        async onElicitation(params, { signal }) {
          const approval = nativeAppApprovalOptions(params);
          // Cancel, not decline: nothing was decided, so a retry after `lcu apps allow` is not refused.
          const unshown = () => {
            if (approval) relay.noteApproval(approval.resource);
            return { action: 'cancel' };
          };
          if (!relay.server?.getClientCapabilities()?.elicitation) return unshown();
          const started = Date.now();
          try {
            const answer = await relay.server.elicitInput(approval ? nativeApprovalForm(params, approval) : params,
              { signal, timeout: APPROVAL_TIMEOUT_MS });
            if (approval && answer.action === 'accept') return nativeAppApprovalResponse(params, answer.content?.choice);
            // A host that cannot show the form cancels it within milliseconds; a person dismissing the terminal
            // form takes longer and gets no hint.
            if (answer.action === 'cancel' && !signal?.aborted && Date.now() - started < UNSHOWN_CANCEL_MS) return unshown();
            return answer;
          } catch {
            return signal?.aborted ? { action: 'cancel' } : unshown();
          }
        },
      };
    },
  });
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--hook') {
    await runHook();
  } else {
    if (!args.length) throw new Error('Usage: grok.mjs ORIGINAL_MCP_COMMAND [ARG ...] | grok.mjs --hook');
    const relay = await runRelay(args);
    for (const signal of ['SIGHUP', 'SIGTERM']) process.once(signal, () => relay.close().finally(() => process.exit(0)));
  }
}
