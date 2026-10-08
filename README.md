# General Forum

General Forum brings the public issues and replies of every public `draykerdk` repository, and the pull requests merged into each repository's main branch, into one reading surface at [forum.drayker.org](https://forum.drayker.org/). Discussions remain connected to their source repositories, where replies and decisions are recorded.

Search, filters by part of the system, label and status, and a permanent page for every thread help readers follow the public record and return to the original thread to take part.

A readable public conversation helps people understand how proposals evolve and where their own contribution can be useful.

## Deliberation standard: kind to people, relentless with ideas

Public discussions across issues, pull requests and the forum follow the principle that governs every discussion in Drayker, as set out in [CONTRIBUTING.md](https://github.com/draykerdk/.github/blob/master/CONTRIBUTING.md): the system is kind to people and relentless with ideas.

- **Kind to people:** every person is protected unconditionally in their dignity, context and belonging. Personal attacks, ad hominem rhetoric, condescension and harassment are not tolerated.
- **Relentless with ideas:** every hypothesis, design and allocation is tested with uncompromising empirical rigor. No idea is protected from grounded criticism, not even Drayker's own. Grounded criticism counts as cooperation, and a failed idea does not cost its author the place to learn and keep contributing.

## Public entry routes

- **Want to read or start a public conversation?** Begin at [forum.drayker.org](https://forum.drayker.org/). The forum keeps no accounts and no database. Publishing always continues on GitHub under your own account.
- **Want to contribute?** Use the [volunteer introduction](https://github.com/draykerdk/general-forum/issues/new?template=volunteer-introduction.yml). Share only information you are comfortable publishing. Participation is voluntary and does not promise compensation or placement.
- **Represent a possible partner?** Use the [partnership proposal](https://github.com/draykerdk/general-forum/issues/new?template=partnership.yml). This begins a public discussion and is not a contract, endorsement or funding commitment.
- **Have a concrete proposal?** Use the [proposal form](https://github.com/draykerdk/general-forum/issues/new?template=proposal.yml), or compose it through the forum so the relevant fields are carried into GitHub.
- **Already know the component?** Open the issue directly beside the documentation or code it concerns.

## Where things usually belong instead

| If it is about… | Open it in |
| --- | --- |
| The method, a protocol, the constitution, or a proposal's path | [`dfmp`](https://github.com/draykerdk/dfmp) |
| Papers, roadmap or the knowledge base | [`dknowledge`](https://github.com/draykerdk/dknowledge) |
| The kernel, its structure, network or security | [`dk`](https://github.com/draykerdk/dk), [`bsdk`](https://github.com/draykerdk/bsdk), [`dk-network`](https://github.com/draykerdk/dk-network), [`living-cryptography`](https://github.com/draykerdk/living-cryptography) |
| Identity and applications | [`uid`](https://github.com/draykerdk/uid) |
| The federation and its resources | [`daf`](https://github.com/draykerdk/daf) |
| Proposing a new project | [`dfmpproject`](https://github.com/draykerdk/dfmpproject) |
| Something with no home yet | [`emergence-initiative`](https://github.com/draykerdk/emergence-initiative) |
| The participation portal itself | [`drayker.org`](https://github.com/draykerdk/drayker.org) |

## Looking for something to work on?

Issues small enough for one person to finish carry the `open-function` label across the `draykerdk` repositories and appear on the board at [drayker.org/fn](https://drayker.org/fn/). If nothing there fits, use the [volunteer introduction](https://github.com/draykerdk/general-forum/issues/new?template=volunteer-introduction.yml) and a first function can be shaped with you.

## How the forum works

- **No server.** About every 15 minutes, the *Forum site* workflow in this repository reads the issues and comments of every public `draykerdk` repository, and the pull requests merged into each repository's main branch, through the GitHub API. It sanitizes the content, writes a static page for every thread, the feeds and the sitemap, and publishes to GitHub Pages when something changed, and at least once a day.
- **Publishing stays on GitHub.** The forum keeps no accounts and no database. Posts and replies are written on GitHub under each person's own account; edits and deletions made there reach the forum at the next update.
- **In the browser.** Pages read the published files. A thread page may make one public GitHub API call to show replies posted since the last update, and a thread opened after the last update is read live from GitHub until its page is published.
- **Public files.** `/data/forum.json` (threads, decisions and repositories), `/data/t/<repository>/<number>.json` (one thread with its replies), `/feed.xml` (new threads), `/decisions/feed.xml` (pull requests merged into a main branch), `/sitemap.xml` and `/llms.txt`. The `.github` repository appears under the path name `dot-github`.

### Working on the site

```bash
npm run build:fixture   # build _site from recorded API responses in test/fixtures
npm run serve           # preview _site at http://localhost:4321
npm test                # data, site and interface checks
```

`npm run build` reads the live API instead (set `GH_TOKEN` for a higher rate limit). `index.html` is the only page source: `tools/prerender.js` writes every route into `_site/`, and `support.js` is the shared generated runtime, never edited by hand. Pull requests run the same checks on the recorded fixture.

GitHub pauses scheduled workflows in public repositories after 60 days without repository activity. If the forum stops updating, run the *Forum site* workflow by hand from the Actions tab.

---

Drayker is a supersystem in a founding R&D phase, meant to be constituted by members. Voluntary contribution is the public entry today. [DFMP](https://dfmp.drayker.org) describes the method and [DAF](https://daf.drayker.org), the Distributed Autonomous Federation, is an autonomous federation of autonomous units and a basic and primitive form of PAP, implemented now on GitHub (Phase 0): its rules, instruments and public record exist; no unit has been recorded and no assembly has been held yet. The governance actually in force is documented in [`draykerdk/.github`](https://github.com/draykerdk/.github/blob/master/GOVERNANCE.md).

Code under MIT (see `LICENSE`), content under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
