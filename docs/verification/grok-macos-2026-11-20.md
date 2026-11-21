# Manual Grok CLI runs on macOS, 2026-11-20

This records the manual and offline checks of the experimental Grok CLI adapter (`docs/ADAPTERS.md#grok-cli`). The user ran them on their own Mac with interactive Grok CLI. The automated protocol probes are in the adapter section; this record holds the hand-run checks and the version pairs they used.

## Host

| Item | Value |
| --- | --- |
| Machine | macOS 27.2 arm64 |
| Grok CLI | 1.0.92 (`b06756fd6256`) |
| ChatGPT.app (offline installation, repeat registration) | 26.1111.71704, observed CUA version `local` |
| ChatGPT.app (rebuilt archive install) | 26.1117.41037, observed CUA version `local` |
| Tested pair | No (informational) |

## TextEdit

The user asked interactive Grok CLI to read the first line of an open TextEdit document through LCU. Grok displayed the TextEdit approval, LCU recorded an accept, and the user confirmed the returned line. The user also confirmed a follow-up CLI test that appended one line, preserved the existing text and read the new line back.

## Calculator

In an interactive Grok CLI test, the user selected Always Allow for Calculator and confirmed that the button sequence for 8 × 7 produced 56 in the app. With that grant in place, the user confirmed in a later Grok CLI prompt that Grok read the displayed 56, clicked through an addition and reported the resulting 65 shown in Calculator.

## Send now and queued follow-up

On November 20, 2026, after installing a rebuilt archive, the user ran a Calculator sequence in interactive Grok CLI in macOS Terminal and used send now (`Ctrl+O`) after the first LCU call. LCU's diagnostic log recorded the first call, an upstream `Interrupt` for that turn when the new prompt started (Grok sends no end report for a cancel-and-send), then two successful calls for the new prompt and its `Stop`. The user confirmed that Calculator showed `0+10` = 10, as Grok reported.

In T3 Code's integrated terminal, `Ctrl+Enter` arrived as a plain Enter, so the follow-up queued and ran after the first turn ended, as Grok documents for terminals it does not recognize.

## Image in Preview

In a manual interactive Grok CLI test, the user opened an image that was new to Grok in macOS Preview and confirmed that Grok accurately answered questions about its contents. That test does not separate what the model saw in the screenshot from what it read in the accessibility tree.

In the separate automated transport tests, the relay preserved the MCP image block, and Grok sent the PNG to the model as a text data URL inside the tool output, not as image input, on the probed Chat Completions and Responses routes.

## Installation against the local ChatGPT app

The task-owned UTM guest was unavailable. The offline installation and repeat registration used the signed local ChatGPT app 26.1111.71704, observed CUA version `local`; the rebuilt archive later installed against ChatGPT 26.1117.41037 with CUA `local`. Neither pair is in the informational tested-versions record.
