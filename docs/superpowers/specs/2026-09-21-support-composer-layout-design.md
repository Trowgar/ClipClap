# Support composer layout

## Goal

Make the Dashboard support composer feel deliberate inside the narrow floating widget. The message field must not compete horizontally with the send action.

## Design

- Keep the composer attached to the bottom of the support panel.
- Use a fixed-height 80px textarea with manual resizing disabled.
- Give the textarea the full available width.
- Keep the keyboard shortcut and character count in a compact row below the textarea.
- Place a 100%-width, 40px-high Send button below that row, with the existing icon and label centered.
- Preserve current disabled, loading, keyboard-submit, validation, and accessibility behavior.

## Scope

Only the composer layout and utility classes in `apps/web/components/support-chat.tsx` change. Message loading, sending, retries, APIs, and the widget shell remain unchanged. No dependency or abstraction is added.

## Verification

- A component test asserts the fixed, non-resizable textarea and full-width send button.
- Existing support tests and the web build must pass.
- The production widget is checked at desktop and narrow/mobile widths.
