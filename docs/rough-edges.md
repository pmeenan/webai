# Rough edges — platform & library findings log

Browser bugs, spec gaps, library quirks, surprising limits, performance cliffs, and
missing capabilities encountered while building and using WebAI. This log is a
first-class project output (root AGENTS.md rule 2): the tool exists to probe exactly
this territory, and evidence-backed findings are useful to browser and library teams
beyond the tool itself.

**Before adding:** grep for the API/library involved to avoid duplicates; extend an
existing entry with new evidence rather than forking it. **Before debugging browser
weirdness:** check here first — it may be known.

Every entry needs: environment (browser + version, OS, hardware where relevant),
a minimal reproduction or measurement, and observed vs. expected behavior. Findings
grounded in a claim about what "should" work cite current documentation (root rule 4).

Format:

```
## RE-NNN: Title  (YYYY-MM-DD, status: open | fixed-upstream | worked-around | wontfix)
Environment / Repro or measurement / Observed / Expected / Impact on WebAI / Links
```

Newest first. RE-numbers are never reused.

---

*(no findings yet — the first entries are expected from the M0 hosting and
Hugging Face API spikes)*
