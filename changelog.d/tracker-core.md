section: Added
audience: user

- Workspace ticket tracking now supports ticket records, workflow states, activity history, filters and search. `TABULA_TRACKER` keeps ticket tools off by default; enable it with an MCP token that has tracker read or write access. The `due:today` filter uses UTC until workspace time zones are supported.
- Tracker tickets now support projects, milestones and bidirectional relations, with saved views and MCP tools to manage them. Relation changes are recorded on both tickets; shared views run with the caller's access.
- Ticket filters now support negation, comma-separated value lists, creators, priorities, state categories, dates, project and milestone names, and parent/blocking relations. Saved views accept the same grammar; week and calendar date filters use UTC.
