# Find with filters

Run **Refyntra: Find** and type a name. Narrow the search with filters:

| Filter | Example | Finds |
|---|---|---|
| `type:` | `type:Order` | classes, interfaces, records, enums |
| `member:` | `member:Get` | methods, properties, fields |
| `project:NAME` | `project:Shop.Api Order` | results in one project |
| `route:TEXT` | `route:/orders` | ASP.NET Core endpoints by route |
| `method:VERB` | `method:POST` | endpoints by HTTP method |

`route:` and `method:` combine (`route:/orders method:GET`); `type:` and `member:` cannot be combined with each other
or with the endpoint filters.
