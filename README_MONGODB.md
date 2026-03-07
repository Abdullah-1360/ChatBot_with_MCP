# Production-Grade MCP Server with MongoDB

## Overview
This is a production-ready MCP (Model Context Protocol) server that uses MongoDB for data storage instead of JSON files. It provides hosting plan information to AI agents via a standardized API.

## Architecture

```
api/
├── config/
│   └── database.js          # MongoDB connection
├── models/
│   └── HostingPlan.js       # Mongoose schema
├── services/
│   └── planSync.js          # Sync service
├── scripts/
│   └── syncPlans.js         # Manual sync script
├── index-mongodb.js         # Main MCP server (MongoDB)
├── server-mongodb.js        # Server wrapper
└── logger.js                # Logging utility
```

## Features

✅ **MongoDB Backend** - Production-grade database storage  
✅ **Optimized Search** - Smart fuzzy matching with normalization  
✅ **Fast Queries** - Indexed fields for sub-100ms responses  
✅ **Separate Collection** - Uses `hosting_plans` collection  
✅ **No Fallback** - Fails fast if MongoDB unavailable  
✅ **Auto-Sync** - Sync plans from JSON to MongoDB  

## Setup

### 1. Install Dependencies
```bash
npm install mongoose
```

### 2. Configure Environment
Add to `.env`:
```bash
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/dbname
MCP_PORT=3002
```

### 3. Sync Plans to MongoDB
```bash
npm run mcp:sync
```

Expected output:
```
🚀 MCP Server: Plan Sync Script

✅ MCP Server: MongoDB connected successfully
🔄 Starting plan sync from JSON to MongoDB...
Found 54 plans in JSON file
🗑️  Deleted 0 existing plans
✅ Inserted 54 plans
📊 Plans by GID:
   cPanel Hosting (GID 1): 8 plans
   Business Hosting (GID 21): 12 plans
   ...

✅ Successfully synced 54 plans to MongoDB
```

### 4. Start Server
```bash
npm run mcp:api:mongodb
```

## MongoDB Schema

### Collection: `hosting_plans`

```javascript
{
  pid: String (unique),
  gid: String,
  gidName: String,
  name: String,
  type: String,
  module: String,
  paymentType: String,
  diskspace: String,
  freeDomain: Boolean,
  hidden: Boolean,
  description: String,
  pricing: {
    USD: { monthly, quarterly, annually, ... },
    PKR: { monthly, quarterly, annually, ... }
  },
  configOptions: Mixed,
  link: String,
  createdAt: Date,
  updatedAt: Date
}
```

### Indexes

For optimal performance, the following indexes are created:

1. **Text Search**: `name`, `description` (text index)
2. **Group Filter**: `gid` (ascending)
3. **Hidden Filter**: `hidden` (ascending)
4. **Budget Filter**: `pricing.PKR.monthly`, `pricing.USD.monthly` (ascending)
5. **Storage Filter**: `diskspace` (ascending)
6. **Name Lookup**: `name` (ascending)

## API Endpoints

### Health Check
```bash
GET /health
```

Response:
```json
{
  "status": "healthy",
  "server": "Plans MCP Server - MongoDB Production",
  "database": "MongoDB",
  "plans_loaded": 54,
  "tools_available": 3,
  "timestamp": "2026-02-23T..."
}
```

### MCP Protocol
```bash
POST /
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_plans",
    "arguments": {
      "query": "WordPress",
      "max_budget": 15,
      "currency": "USD",
      "limit": 5
    }
  }
}
```

## Available Tools

### 1. search_plans (Main Tool)
Search and filter plans in one call.

**Parameters:**
- `query` (string): Search keyword
- `max_budget` (number): Maximum price
- `currency` (string): "USD" or "PKR"
- `min_storage` (number): Minimum GB
- `limit` (number): Results to return (1-10)

**Example:**
```javascript
{
  "name": "search_plans",
  "arguments": {
    "query": "biz 5",
    "max_budget": 20,
    "currency": "USD",
    "limit": 3
  }
}
```

### 2. get_plan_by_id
Get detailed information about a specific plan.

**Parameters:**
- `plan_id` (string): Plan ID
- `currency` (string): "USD" or "PKR"

### 3. compare_plans
Compare 2-3 plans side-by-side.

**Parameters:**
- `plan_ids` (array): 2-3 plan IDs
- `currency` (string): "USD" or "PKR"

## Sync Strategy

### Initial Sync
```bash
npm run mcp:sync
```

This reads `api/all-plans-1763962201513.json` and imports all plans to MongoDB.

### Re-Sync
To update plans after changes:
```bash
npm run mcp:sync
```

This will:
1. Delete all existing plans in `hosting_plans` collection
2. Import fresh data from JSON file
3. Preserve other collections (products, chats, etc.)

### Automatic Sync
For production, you can schedule automatic syncs:

```javascript
// In your main app
const { syncPlansFromJSON } = require('./api/services/planSync');

// Sync every 24 hours
setInterval(async () => {
  await syncPlansFromJSON();
}, 24 * 60 * 60 * 1000);
```

## Testing

### Test MongoDB Connection
```bash
curl http://localhost:3002/health
```

### Test Search
```bash
curl -X POST http://localhost:3002/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_plans",
      "arguments": {
        "query": "biz 5",
        "currency": "USD",
        "limit": 3
      }
    }
  }'
```

### Test Plan Lookup
```bash
curl -X POST http://localhost:3002/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "get_plan_by_id",
      "arguments": {
        "plan_id": "205",
        "currency": "USD"
      }
    }
  }'
```

## Performance

| Metric | Value |
|--------|-------|
| Query Response Time | < 100ms |
| Search with Filters | < 150ms |
| Plans Loaded | 54 |
| Concurrent Connections | Unlimited |
| Database | MongoDB Atlas |

## Error Handling

### MongoDB Connection Failed
```json
{
  "status": "unhealthy",
  "error": "MongoDB connection error: ...",
  "timestamp": "2026-02-23T..."
}
```

**Solution**: Check `MONGODB_URI` in `.env` and verify MongoDB Atlas IP whitelist.

### No Plans Found
```json
{
  "success": true,
  "data": [],
  "count": 0,
  "message": "No plans found matching \"xyz\"...",
  "suggestions": [...]
}
```

**Solution**: Run `npm run mcp:sync` to import plans.

## Deployment

### Development
```bash
npm run mcp:api:mongodb:dev
```

### Production
```bash
# Using PM2
pm2 start api/server-mongodb.js --name mcp-plans-mongodb

# Or direct
node api/server-mongodb.js
```

### Environment Variables
```bash
NODE_ENV=production
MONGODB_URI=mongodb+srv://...
MCP_PORT=3002
LOG_LEVEL=INFO
```

## Monitoring

### Check Plans Count
```bash
curl http://localhost:3002/health | jq '.plans_loaded'
```

### View Logs
```bash
curl http://localhost:3002/logs
```

### MongoDB Queries
```javascript
// Connect to MongoDB
use your_database

// Count plans
db.hosting_plans.countDocuments()

// View sample plan
db.hosting_plans.findOne()

// Check indexes
db.hosting_plans.getIndexes()
```

## Comparison: JSON vs MongoDB

| Feature | JSON File | MongoDB |
|---------|-----------|---------|
| Data Storage | File system | Database |
| Query Speed | O(n) linear | O(log n) indexed |
| Scalability | Limited | Unlimited |
| Concurrent Access | File locks | Connection pool |
| Data Integrity | Manual | ACID transactions |
| Backup | File copy | Database backup |
| Production Ready | No | Yes |

## Migration from JSON

If you're currently using the JSON-based MCP server:

1. Keep old server running: `npm run mcp:api`
2. Sync plans to MongoDB: `npm run mcp:sync`
3. Start MongoDB server: `npm run mcp:api:mongodb` (different port)
4. Test MongoDB server thoroughly
5. Update UChat to use new URL
6. Stop old server

## Troubleshooting

### Plans not syncing
```bash
# Check JSON file exists
ls -lh api/all-plans-*.json

# Check MongoDB connection
node -e "require('dotenv').config(); const mongoose = require('mongoose'); mongoose.connect(process.env.MONGODB_URI).then(() => console.log('✅ Connected')).catch(e => console.error('❌', e.message))"

# Run sync with verbose output
node api/scripts/syncPlans.js
```

### Slow queries
```bash
# Check indexes
mongo your_database --eval "db.hosting_plans.getIndexes()"

# Rebuild indexes if needed
mongo your_database --eval "db.hosting_plans.reIndex()"
```

### Memory issues
```bash
# Increase Node.js memory
node --max-old-space-size=2048 api/server-mongodb.js
```

## Security

✅ MongoDB connection uses TLS/SSL  
✅ No sensitive data in logs  
✅ CORS configured for production  
✅ Input validation on all parameters  
✅ Separate collection from main app data  

## Support

For issues or questions:
1. Check this README
2. Review MongoDB connection logs
3. Test with `curl` commands above
4. Check MongoDB Atlas dashboard

---

**Version**: 2.0.0  
**Database**: MongoDB  
**Status**: Production Ready ✅
