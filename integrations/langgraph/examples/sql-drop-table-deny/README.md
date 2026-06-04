# LangGraph SQL Drop Table Deny

Expected result:

- action: `tool.sql.execute`
- verdict: `DENY`
- dispatch: false
- reason code: `SQL_DESTRUCTIVE_MUTATION_DENY`
