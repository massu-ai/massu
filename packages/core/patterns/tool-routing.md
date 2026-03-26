# Tool Routing Patterns

**Purpose**: Decision trees for selecting the correct tool/MCP for browser automation, Google services, and code search.

**When to Read**: Before using any browser automation, Google service, or code search tool.

---

## Browser Automation Routing

| Need | Tool | Why |
|------|------|-----|
| Navigate + screenshot + verify | Playwright CLI (`browser_navigate`, `browser_snapshot`) | Deterministic, accessibility tree, no vision needed |
| Fill forms + click buttons | Playwright CLI (`browser_click`, `browser_fill_form`) | Direct element interaction via ref IDs |
| Complex multi-step flows | Playwright CLI (multiple calls) | Sequential, reliable |
| Visual design review | Playwright CLI `browser_take_screenshot` + vision analysis | Screenshot for LLM visual evaluation |
| Natural language interaction | Stagehand MCP | When element selectors are unclear |
| Generic web scraping | Browser MCP | Non-app browsing tasks |

### Decision Tree

```
Need browser automation?
├── Testing YOUR app (localhost/preview)?
│   ├── Know the element? → Playwright CLI (browser_click, browser_fill_form)
│   ├── Need page state? → Playwright CLI (browser_snapshot)
│   ├── Need screenshot? → Playwright CLI (browser_take_screenshot)
│   └── Complex flow? → Playwright CLI (sequential calls)
├── Scraping external site?
│   └── → Browser MCP or WebFetch
└── Natural language interaction needed?
    └── → Stagehand MCP
```

---

## Google Services Routing

| Need | Tool | Why |
|------|------|-----|
| Read/write spreadsheets | Google Workspace MCP | Direct API access |
| Send email | Google Workspace MCP (`send_gmail_message`) | Gmail API |
| Calendar events | Google Workspace MCP (`get_events`, `manage_event`) | Calendar API |
| Drive files | Google Workspace MCP (`search_drive_files`, `get_drive_file_content`) | Drive API |
| Apps Script management | Google Workspace MCP (`get_script_content`, `update_script_content`) | Direct script access |
| Run Apps Script function | Google Workspace MCP (`run_script_function`) | Execute deployed functions |
| Create Apps Script project | Google Workspace MCP (`create_script_project`) | Project scaffolding |

---

## Code Search Routing

| Need | Tool | Why |
|------|------|-----|
| Find files by name/pattern | Glob | Fast pattern matching, sorted by modification time |
| Search file contents | Grep | Regex search with context, line numbers |
| Understand call graph | Codegraph MCP (`codegraph_callers`, `codegraph_callees`) | Relationship analysis |
| Impact analysis | Codegraph MCP (`codegraph_impact`) | What would break if X changes |
| Multi-round exploration | Task agent | Open-ended investigation |

### Decision Tree

```
Need to find something in code?
├── Know the filename pattern?
│   └── → Glob ("**/*.tsx", "src/**/*service*")
├── Know what the code contains?
│   ├── Simple pattern? → Grep (pattern, path)
│   └── Complex regex? → Grep (multiline: true)
├── Need to understand relationships?
│   ├── Who calls this? → codegraph_callers
│   ├── What does this call? → codegraph_callees
│   └── What breaks if I change this? → codegraph_impact
└── Open-ended exploration?
    └── → Task agent (multiple search rounds)
```

---

**Document Status**: ACTIVE
**Compliance**: Use routing tables before selecting tools
