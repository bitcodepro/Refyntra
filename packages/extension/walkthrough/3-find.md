# Find with filters

Run **Refyntra: Find** and type a name. Narrow the search with filters:

| Filter | Example | Finds |
|---|---|---|
| `type:` | `type:Order` | classes, interfaces, records, enums |
| `member:` | `member:Get` | methods, properties, fields |
| `project:NAME` | `project:Shop.Api Order` | results in one project |
| `route:TEXT` | `route:/orders` | ASP.NET Core endpoints by route |
| `method:VERB` | `method:POST` | endpoints by HTTP method |
| `entity:` | `entity:Order` | EF Core entities (types mapped by a DbContext) |
| `table:NAME` | `table:orders` | EF Core entities by mapped table name (explicit or convention) |

`route:` and `method:` combine (`route:/orders method:GET`); `type:` and `member:` cannot be combined with each other
or with the endpoint filters. `entity:` and `table:` combine with each other and with `project:`, not with `member:`,
`route:` or `method:`.
