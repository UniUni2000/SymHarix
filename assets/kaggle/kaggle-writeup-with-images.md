# SymHarix: Turn a Telegram Message into a Verified Pull Request

**Subtitle:** From Telegram to verified PRs: Gemma 4 supervises requirements, coding agents, review gates, and progress cards anywhere.

## What We Built

SymHarix is a Telegram-first AI supervisor for software delivery. It lets a user open Telegram, describe a coding task in natural language, clarify requirements with an AI Supervisor, approve a plan, and then watch the work move toward a verified GitHub pull request.

![SymHarix architecture](https://raw.githubusercontent.com/UniUni2000/SymHarix/main/assets/kaggle/architecture-intro.png)

*SymHarix turns a Telegram message into a supervised, verified pull request.*

The core idea is simple: coding agents are powerful, but they are still hard to supervise. Users often need to sit at a laptop, inspect logs, translate vague requests into issues, check whether the agent understood the repository, review the pull request, and decide whether the result is safe to merge. SymHarix turns that whole loop into a mobile-first control plane.

## How Gemma 4 Is Used

In our submission, Gemma 4 acts as the Supervisor brain. It handles the front-door conversation: understanding the user's request, asking follow-up questions, reasoning about the target repository, preparing a Plan Card, choosing the next tool action, and deciding when the work needs user approval.

Gemma 4 does not just answer chat messages. It supervises a delivery workflow. Once the user approves a plan, SymHarix routes the task into our Symphony + Harness system: Symphony manages the professional code lifecycle from requirement intake to development, review, pull request, and merge; Harness adds quality gates, review evidence, delivery state, and failure visibility.

## The User Experience

A user can deploy SymHarix on a server, connect Telegram, GitHub, and their repositories, and then manage development work from anywhere.

![Telegram conversation](https://raw.githubusercontent.com/UniUni2000/SymHarix/main/assets/kaggle/telegram-conversation.png)

*The user starts from Telegram, not an IDE or dashboard.*

A typical flow looks like this:

1. The user sends a request in Telegram.
2. Gemma 4, as the Supervisor, clarifies the goal and checks repository context.
3. SymHarix generates a Plan Card for approval.
4. After approval, coding agents execute the task through the configured runtime.
5. Harness checks the result, records evidence, and surfaces blockers.
6. The user monitors progress through Telegram preview cards, Runtime Deck, and a Telegram Mini App.
7. The final outcome is a reviewed pull request with visible delivery state.

![Plan Card approval](https://raw.githubusercontent.com/UniUni2000/SymHarix/main/assets/kaggle/plan-card-approval.png)

*Gemma 4 prepares a Plan Card before any code is written.*

This makes agentic software development practical for real operators: founders, maintainers, small teams, and developers who cannot constantly babysit a terminal. The user stays in control, but no longer has to stay glued to a computer.

![Runtime Deck progress](https://raw.githubusercontent.com/UniUni2000/SymHarix/main/assets/kaggle/runtime-deck-progress.png)

*Runtime Deck gives operators a live view of the delivery state.*

![Telegram Mini App detail view](https://raw.githubusercontent.com/UniUni2000/SymHarix/main/assets/kaggle/mini-app-detail.png)

*Mini App views make mobile monitoring richer than plain bot messages.*

## Demo Video Placeholder

The final demo video will show the full path from a Telegram request to a verified pull request: requirement clarification, Plan Card approval, live progress cards, Runtime Deck monitoring, Mini App inspection, Harness review evidence, and the final GitHub PR.

![Demo video placeholder](https://raw.githubusercontent.com/UniUni2000/SymHarix/main/assets/kaggle/video-placeholder.png)

## Why It Matters

SymHarix is not another chat wrapper around a coding agent. It is a supervised delivery layer for real software work. The project combines Gemma 4's conversational planning ability with a structured engineering workflow, so AI coding becomes easier to trust, easier to monitor, and easier to use from anywhere.

![Harness evidence](https://raw.githubusercontent.com/UniUni2000/SymHarix/main/assets/kaggle/harness-evidence.png)

*Harness evidence helps judges see reliability, not just a happy-path demo.*

![Verified GitHub pull request](https://raw.githubusercontent.com/UniUni2000/SymHarix/main/assets/kaggle/verified-github-pr.png)

*The workflow ends in a reviewed pull request, not just a chat response.*

![Before and after supervision](https://raw.githubusercontent.com/UniUni2000/SymHarix/main/assets/kaggle/before-after-supervision.png)

*SymHarix replaces laptop babysitting with supervised mobile delivery.*

