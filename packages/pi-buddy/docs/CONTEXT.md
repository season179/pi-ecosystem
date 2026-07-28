# Buddy

Buddy gives a Pi agent a candid, read-only second opinion while preserving the
main agent's responsibility for decisions and actions.

## Language

**Consultation**:
A requested exchange in which Buddy examines the active transcript and answers from a chosen stance.
_Avoid_: Chat, query, completion

**Stance**:
The requested mode of engagement for a Consultation: discuss, debate, fact-check, or review.
_Avoid_: Persona, mode

**Automatic Review**:
A background examination triggered by advisory cadence or the end of a run.
_Avoid_: Push, background consultation

**Review Snapshot**:
The exact session branch and activity revision examined by an Automatic Review.
_Avoid_: Transcript copy, context

**Verdict**:
Buddy's structured decision that an Automatic Review passed, found a Concern, resolved it, confirmed it, or replaced it.
_Avoid_: Result, response

**Concern**:
An actionable problem found by Automatic Review and identified for later disposition.
_Avoid_: Finding, warning, issue

**Concern Disposition**:
The recorded resolution of a Concern as fixed or rebutted with a reason.
_Avoid_: Status, feedback

**Advisory Cadence**:
The session-scoped turn threshold that controls when Automatic Review may begin.
_Avoid_: Frequency, sensitivity

**Evidence**:
Read-only repository or web material used to verify a Consultation or Concern.
_Avoid_: Tool output, context

**Memory Lesson**:
A bounded durable fact or preference harvested from a requested Consultation.
_Avoid_: Memory entry, note

**Retraction**:
A request harvested from a Consultation to remove an obsolete Memory Lesson.
_Avoid_: Delete, correction

**Model Plan**:
The ordered Buddy model candidates, retry allowance, and output limits resolved for one Consultation or Automatic Review.
_Avoid_: Config, model list

## Relationships

- A **Consultation** has exactly one **Stance** and uses one **Model Plan**.
- An **Automatic Review** examines one **Review Snapshot** and produces one **Verdict**.
- A **Verdict** may stage one **Concern** for revalidation against a newer **Review Snapshot**.
- A delivered **Concern** may later receive one terminal **Concern Disposition**.
- **Advisory Cadence** determines when a turn-triggered **Automatic Review** may begin.
- A requested **Consultation** may harvest **Memory Lessons** and **Retractions**.
- **Evidence** may support either a requested **Consultation** or an **Automatic Review**.

## Example dialogue

> **Developer:** "The Advisory Cadence fired an Automatic Review. Can its Concern be delivered now?"
> **Domain expert:** "Only after Buddy revalidates the Concern against a current Review Snapshot and submits a confirming Verdict."

## Flagged ambiguities

- "review" can mean the requested **Stance** or an **Automatic Review**; use the full term when lifecycle behavior matters.
- "feedback" can mean cadence calibration or a **Concern Disposition**; name the intended operation explicitly.
