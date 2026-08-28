# Durak Online Assistant

A web-based helper tool and live Monte Carlo equity calculator for 24-card Durak.

![Durak Assistant Screenshot]
<img width="1485" height="1577" alt="image" src="https://github.com/user-attachments/assets/93284e79-bb6f-4353-b9c7-e3651a466b45" />

## Live Demo
[Launch App](https://<username>.github.io/<repo-name>/)

## Features
- **Live Win Equity:** Information-set Monte Carlo simulation calculating winning odds per turn.
- **Optimal Move Suggestions:** Dynamic card/action recommendations (Attack, Defend, Bito, Take).
- **Hand & Deck Tracking:** Automatic tracking of unknown pool, discard pile, and exact endgame state deduction.
- **Mobile Responsive:** Dark UI optimized for both desktop and mobile viewports.

## Tech Stack
- Vanilla HTML5 / Modern CSS (CSS Grid, Flexbox, Variables)
- Vanilla JavaScript (Monte Carlo Rollout Engine, Exact Endgame Solver)
- Zero external dependencies or build tools required.

## Local Setup
Clone the repository and open `index.html` directly in any web browser:
```bash
git clone [https://github.com/](https://github.com/)<username>/<repo-name>.git
cd <repo-name>
open index.html
