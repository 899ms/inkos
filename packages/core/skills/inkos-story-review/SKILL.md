---
name: inkos-story-review
description: 按题材、目标读者和用户标准审稿，展示具体问题并协作修订。Use for chapter or manuscript review with transparent criteria.
---
# Story review

Use this skill when the user wants diagnosis, scoring, comparison, approval, or revision advice for existing prose.

- First identify the applicable standard from genre, target audience, tone, platform, and explicit user preference. Everyday comedy, literary fiction, romance, mystery, and commercial serials should not share one logic-density threshold.
- In an active book, use the auditor for persisted chapters. Show concrete issue descriptions, severity, evidence, and likely reader impact.
- A parser or model-format failure produces a review-unavailable observation. It is not evidence that the prose is bad and never authorizes a rewrite.
- Revise when the user asks or an explicit production action requests revision; report whether the revised artifact was actually applied.
- Preserve the user's voice and successful passages. Prefer the smallest scope that resolves the real defect.
- For long-form work, compare the chapter with populated memo requirements, recent progression, real hook ids, character knowledge, and reader promises. Repetition is not progression; a payoff, subplot, or emotional line moves only when facts, action, relationship, status, or understanding changes.
- Route repairs by cause: local prose defects may be patched, while missing scenes, broken causality, timeline, viewpoint, character logic, or payoff require structural revision.
- Respond in the user's language.

Load `references/review-matrix.md` for a full review or when standards are disputed.

## Profile dimension catalog

Runtime profiles may provide numeric dimension IDs. Interpret them here rather than in Agent code:

- 1 character fidelity/OOC; 2 timeline; 3 lore conflict; 4 power scaling; 5 numerical consistency; 6 hooks; 7 pacing; 8 style; 9 information boundary; 10 lexical fatigue.
- 11 incentive chain; 12 era accuracy; 13 supporting-character competence; 14 character instrumentalization; 15 payoff delivery; 16 dialogue authenticity; 17 chronicle drift; 18 knowledge-base pollution; 19 viewpoint consistency.
- 20 paragraph uniformity; 21 cliche density; 22 formulaic turns; 23 list-like structure; 24 subplot stagnation; 25 emotional-arc flatline; 26 pacing monotony; 27 sensitive content.
- 28 mainline event conflict; 29 future-knowledge leak; 30 cross-work world-rule consistency; 31 spinoff hook isolation; 32 reader promises; 33 chapter-memo delivery.
- 34 fanfic character fidelity; 35 fanfic world-rule compliance; 36 relationship dynamics; 37 canon-event consistency.

Treat custom dimension names as semantic instructions in their own words. Always inspect reader promises and populated chapter-memo requirements even when the runtime omits IDs 32 and 33. For spinoffs, use parent canon as authority; for fanfic, honor `fanficMode` and explicit allowed deviations. Runtime fatigue words, payoff types, era metadata, and lineage flags specialize the review but do not create automatic rewrite permission.
