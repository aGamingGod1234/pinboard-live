# Dynamic Quiz Answers and Results Design

**Date:** 2026-07-10  
**Status:** Approved design  
**Scope:** Regular quiz answer counts, multiple-correct answers, scoring, live presenter/player states, results, and question images.

## Goal

Make regular quiz questions support two through six answers and one or more correct answers while keeping the editor, authoritative server state, presenter display, player display, scoring, reconnect behavior, and responsive layouts consistent. Improve the live question and result experience without changing the working host/join flow.

## Non-goals

- True/False remains exactly two options with one correct answer.
- Slides remain answer-free.
- No new video uploads or video editor behavior.
- No new quiz question types beyond single-answer and multiple-answer regular quizzes.
- No change to the existing player join, presenter authentication, or room-capacity model.

## Architectural approach

Extend the existing server-authoritative session model instead of implementing independent client-only behaviors. The server remains the source of truth for question state, accepted submissions, timestamps, result finalization, scoring, and phase transitions. Editor, presenter, and player clients render the same normalized question and session data.

User-facing live flow:

`Lobby -> Question -> Answer results -> Leaderboard -> Next question or final podium`

The answer-results phase contains only the question, optional image, answer distribution, and correct-answer indicators. The leaderboard is a separate phase and never appears below the answer graph.

## Data model

### Questions

Regular quiz questions contain:

- `options`: two through six unique option records.
- `correctOptionIds`: one or more unique IDs that all reference current options.
- `points`: the maximum available points for the question.
- `timerSeconds`: the configured natural question duration.
- At most one image reference.

Existing saved questions that contain `correctOptionId` are normalized to a one-entry `correctOptionIds` array when read. New saves use the array form. True/False questions always normalize to two options and exactly one correct ID.

### Player submissions

A submission contains:

- The unique selected option IDs.
- The authoritative server submission timestamp in milliseconds.
- The calculated result outcome and points once the question is finalized.

Single-answer questions accept one option immediately when clicked. Multiple-answer questions accept exactly the number of selections represented by `correctOptionIds`, and submission occurs only when the player presses **Submit answers**. An accepted submission is immutable and idempotent.

Storage and migrations must preserve existing single-option answer records and expand persistence to support selected-option arrays. Reconnects must reconstruct whether the player is selecting, submitted and waiting, viewing a reveal, or viewing the leaderboard.

## Editor experience

### Answer controls

- New regular quiz questions continue to start with four answers.
- **Add answer** appends the next answer up to six and displays `Answers N/6`.
- Each option has a clearly labelled remove control.
- Remove controls are disabled when two options remain.
- The add control is disabled when six options exist.
- Correct-answer controls are toggle buttons or checkboxes with exposed pressed/checked state, not radio buttons.
- At least one correct answer is always required; the last correct toggle cannot be disabled.
- The editor summarizes the rule, for example: **2 correct answers — players select 2.**
- True/False shows fixed options and does not expose add/remove controls.

When a correct option is removed, the nearest remaining option that is not already correct becomes correct so the number of correct answers remains stable whenever possible. Prefer the option that moves into the removed index; when the removed option was last, prefer the preceding option. If every remaining option is already correct, all remaining options stay correct and the correct-answer count decreases with the option count. The presenter can change the resulting toggles manually.

### Question images

- The file picker accepts supported raster image types only.
- A question has at most one image.
- Selecting an image updates the editor preview immediately.
- Once present, the preview replaces the upload chooser.
- Hovering the image or focusing its wrapper reveals an accessible remove button at the top-right.
- Removing the image restores the chooser and marks the draft dirty.
- Invalid, oversized, or failed uploads preserve the existing image and show a persistent error.
- Live presenter images are centered, contained, and never stretched.

## Presenter experience

### Active question

- The countdown is a dominant stage element rather than small top-right metadata.
- It displays the remaining time prominently and adds restrained urgency styling near zero.
- Multi-answer questions clearly state **Players must select N answers**.
- The answer-progress indicator continues to report submitted players, not individual option selections.

### Answer results

- Results show a responsive bar graph containing every option.
- Each bar uses its stable option color and shape and includes answer text, selection count, and percentage of submitted players. When nobody submitted, every percentage is zero.
- Multiple-answer counts represent how many submitted players selected that option; totals may exceed the player submission count.
- Every correct option has an obvious correct marker and stronger visual treatment.
- The question image, when present, is centered above or beside the graph according to available width.
- No leaderboard or player ranking appears on this screen.
- **Next** advances to the dedicated leaderboard.

### Leaderboard

- The leaderboard is a dedicated phase after every answer-results phase.
- **Next** advances from the leaderboard to the next question.
- After the final question, the flow advances to the existing final podium instead.

## Player experience

### Answer layouts

All option counts use the six existing stable tone/shape pairs.

- Two answers: two balanced columns on wide screens.
- Three answers: a balanced three-option layout without an awkward empty tile.
- Four answers: 2 by 2.
- Five or six answers: 3 by 2 on wide screens.
- Phone layouts use two columns where readable and collapse further only when required to prevent overflow.
- Answer text remains visible, wraps safely, and retains distinct accessible names including option number, color, shape, and text.

### Submission

- Single-answer questions submit immediately on selection.
- Multiple-answer questions show **Select N answers**, a live `X of N selected` counter, and toggleable options.
- Players cannot select more than N options.
- **Submit answers** appears only for multiple-answer questions and is enabled only when exactly N options are selected.
- The multi-answer response timestamp is the server time when **Submit answers** is accepted.

### Waiting and reveal

After submission, the answer grid is replaced with a non-interactive waiting screen. It uses a neutral phrase that does not reveal correctness, such as **Lightning fast — but did you get it right?** The chosen phrase remains stable across rerenders and reconnects.

When the presenter reveals results, the player sees one of four explicit outcomes:

- **Correct**
- **Partially correct**
- **Incorrect**
- **Time's up**

The reveal shows points gained, the player's selected answers, the correct answers, and a short contextual phrase such as **Lightning fast and lightning smart**, **Nice work**, **So close**, or **Better luck next time**. The screen is not interactive and does not return to the selection menu.

## Timing and scoring

All calculations use authoritative millisecond timestamps and dynamic question values. No score constant assumes a particular timer or point value.

Define:

- `elapsedMs`: accepted submission time minus the server question-open time.
- `effectiveDurationMs`: configured duration in milliseconds when time expires naturally, or the exact elapsed milliseconds between question opening and the presenter pressing **Skip timer**, clamped to a minimum of one millisecond to prevent division by zero.
- `questionPoints`: the configured maximum points.

At result finalization:

```text
timeValue = ceil(questionPoints * max(0, 1 - elapsedMs / effectiveDurationMs))
awardedPoints = ceil(timeValue * correctlySelected / totalCorrectAnswers)
```

Rules:

- A correct submission at zero elapsed time earns the configured maximum.
- A submission at the effective deadline earns zero.
- Every millisecond reduces the available time value continuously.
- Wrong selections occupy selection slots but add no partial-credit share.
- Players are limited to the number of actual correct answers, preventing select-all behavior.
- No accepted submission earns zero and produces **Time's up**.
- A fully incorrect accepted submission earns zero and produces **Incorrect**.
- A submission containing some but not all correct options produces **Partially correct** and earns the corresponding fraction.
- A submission containing every correct option produces **Correct**.
- Scores are finalized only when results are revealed because a presenter Skip action can change the effective duration.

The server serializes answer submissions and Skip actions. A submission committed before Skip participates using its timestamp; a submission arriving after the finalized cutoff is rejected as late.

## Validation and error handling

- Validate option counts, unique IDs, correct-ID membership, correct-ID uniqueness, and non-empty correct sets on presentation save and session creation.
- Validate selected IDs, uniqueness, membership, exact selection count, player identity, active question, and timing on submission.
- Reject duplicate submissions without changing the original submission.
- Preserve unsaved editor state when a save or upload fails.
- Provide clear messages when answer or correct-answer limits prevent an action.
- Keep media signature validation and storage quotas; client file filtering is not treated as a security boundary.
- Never expose internal errors or accept client-computed timestamps or scores.

## Accessibility and motion

- Correct-answer toggles expose checked/pressed state and descriptive names.
- Add/remove controls explain their disabled limits.
- Selection counters, submission state, and reveal outcomes use appropriate live regions.
- Graph bars expose answer text, selection count, percentage, and correctness as accessible labels.
- Correctness is communicated with text and icons in addition to color.
- Keyboard and touch users can operate every editor and player control.
- New transitions are brief and respect `prefers-reduced-motion`.

## Verification strategy

### Unit coverage

- Millisecond scoring at start, midpoint, deadline, and arbitrary timers/point values.
- Skip-timer effective duration.
- Partial-credit calculations and rounding.
- Correct, partial, incorrect, and timed-out outcomes.
- Nearest-correct replacement after removal.
- Option/correct-selection bounds and legacy normalization.

### Integration coverage

- Presentation save/load with two through six options and multiple correct IDs.
- Persistence and restoration of multi-option submissions.
- Natural timeout and Skip result finalization.
- Concurrent submission/Skip ordering and duplicate submission rejection.
- Reconnect during selection, waiting, reveal, and leaderboard phases.
- Image add/remove persistence and server-side image validation.

### Browser coverage

- Editor add/remove limits, correct toggles, summary text, and True/False fixed behavior.
- Immediate image preview, hidden chooser, accessible remove control, and centered live image.
- Single-click submission and multi-select plus explicit submit.
- Stable waiting messages and all player reveal outcomes.
- Presenter prominent timer, result graph, correct markers, and separate leaderboard.
- Two through six answer layouts on desktop and mobile with no horizontal overflow.
- Keyboard accessibility and reduced-motion behavior.

### Release verification

- Run all unit, integration, PostgreSQL concurrency, and Playwright tests.
- Pass GitHub CI and automated review.
- Merge the reviewed branch to `main`.
- Deploy the exact merged commit to Railway.
- Verify the production health endpoint, deployment logs, editor flow, live presenter/player flow, multi-answer partial scoring, Skip timing, image behavior, result graph, leaderboard phase, and responsive layouts at the live URL.

## Acceptance criteria

The feature is complete when every approved editor, presenter, player, image, scoring, timeout, partial-credit, responsive, accessibility, persistence, reconnect, testing, GitHub, Railway, and live-verification behavior above is implemented with no known application runtime errors.
