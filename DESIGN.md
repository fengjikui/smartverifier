# SmartVerifier design

## Physical setting and theme

Inspectors hold a phone at a bright factory bench and need to read tiny markings without squinting. Use a light app surface, charcoal text, and a darker neutral photographic stage that separates photographs from controls. Preserve the accepted deep green action color.

## Color and type

Use restrained OKLCH tinted neutrals and one deep green accent. Amber indicates uncertainty; red indicates an actionable failure. Use system sans-serif with Chinese fallbacks. Body 15–16px, supporting labels 12–13px, important titles 22–26px. No gradients or display fonts.

## Layout and controls

Portrait phone: compact header with model selection; photographs and conversation form one task; sticky bottom input and photo actions. Crop editing takes a dedicated inline workspace with a framed viewport and accessible controls. Desktop: photo workspace and conversation can sit side by side. Avoid nested cards and decorative statistics.

## Interaction

Minimum primary touch target 44px. Use existing button and slider primitives. Drag translates the image; pinch zooms around the gesture center. Rotation has quarter-turn buttons and a precise slider. A server-generated preview is the final representation sent to the model. Surface loading, cancellation, retry, and model-unavailable states explicitly.

## Motion

Keep state transitions short. Animate opacity and transforms only. Honor prefers-reduced-motion. No animated page entrance.
