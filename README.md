# Zenos Memory

Custom advanced memory system for Zenos / Hermes agent.

**Storage**: Google Drive (primary) + local fallback  
**API**: Next.js (Vercel)  
**Goal**: Better than mem0 — full control, rich metadata, quality-focused, intelligence layer.

## Quick Start (Local)

```bash
npm install
cp .env.example .env
# Edit .env with your GOOGLE_SERVICE_ACCOUNT_KEY and DRIVE_FOLDER_ID
npm run dev
```

Server runs at http://localhost:3090

## Environment

See `.env.example`

Required for Drive:
- `GOOGLE_SERVICE_ACCOUNT_KEY` (JSON string)
- `ZENOS_MEMORY_DRIVE_FOLDER_ID`
- `ZENOS_MEMORY_API_KEY`

For local-only testing:
- Set `USE_LOCAL_STORE=true`

## API

### Remember
`POST /api/memory/remember`

```json
{
  "content": "Tuan likes gass langsung execution style",
  "type": "preference",
  "namespace": "zenos",
  "metadata": {
    "tags": ["style", "etla"],
    "confidence": 0.95,
    "importance": 8
  }
}
```

### Recall
`POST /api/memory/recall`

```json
{
  "query": "execution style",
  "namespace": "zenos",
  "limit": 10,
  "min_confidence": 0.7
}
```

Returns scored results (keyword + recency + importance).

Other:
- POST /api/memory/edit
- POST /api/memory/forget
- GET /api/memory/stats?namespace=zenos

## Auth
All endpoints require:
- `x-api-key: <your-key>` header
- or `Authorization: Bearer <your-key>`

## Roadmap Alignment

See [zenos-memory-roadmap.md](../zenos-memory-roadmap.md) (in parent dir) for full phases.

Current: Phase 0 + Core Engine (remember/recall/edit/forget + basic scoring).

## Deploy to Vercel

```bash
# From this dir
npx vercel --prod --yes
# Set env vars in Vercel dashboard
```

Manual like Zenos Mail:
```bash
npx vercel --prod --token $VERCEL_TOKEN --yes
```

## Future

- Real embeddings (via 9router or Vercel AI)
- Conflict detection
- Relationship graph
- Daily intelligence reports
- File upload indexing
- Integration with Hermes via custom tool

Built by Etla for tuan.

## Important Note about Google Drive Storage

Regular 'My Drive' folders have quota restrictions for Service Accounts.

**You MUST use a Shared Drive (Team Drive)** for the memory storage to work.

Steps:
1. Create Shared Drive in Google Drive
2. Put your folder inside the Shared Drive
3. Share the Shared Drive with the service account email: zenos-memory@zenos-memory.iam.gserviceaccount.com (Manager role)
4. Give the folder ID from inside the Shared Drive

Current service account email: zenos-memory@zenos-memory.iam.gserviceaccount.com


## Storage Limitation (Updated)

Current status:
- Service Account JSON saved securely
- Sharing (Editor) done on folder
- **No Shared Drives available** (personal Gmail account)

Google restricts Service Account storage quota on regular My Drive folders.

**Current active storage**: Local file (persistent on this VPS)

If you get a Google Workspace account later, we can switch to Shared Drive.

For now we proceed with local + continue building features.


### Workaround for Personal Drive (No Shared Drive)

Because Service Accounts have quota restrictions on creating files in regular My Drive:

**Manual pre-creation step (this is the common workaround people use):**

1. As the OWNER (Altedria), go to the 'Zenos Memory' folder.
2. Create a new file named **exactly** `zenos-memories.json`
3. Put this content inside it: `[]`
4. Save the file.
5. Right-click the file → Share → add the service account email with Editor.
6. Tell me when done.

After that the code will find the existing file and only do updates (which usually works on the owner's quota).

I improved the error message in the code to guide this.


## Phase Progress

**Phase 0: Foundation** — ✅ COMPLETE

**Phase 1: Core Memory Engine** — IN PROGRESS
- ✅ remember (single + batch)
- ✅ recall with filters (type, confidence, tags, temporal created_after/before)
- ✅ edit + forget
- ✅ basic versioning + previous versions
- ✅ answer (RAG context compilation)
- ✅ Provenance & typed memory

Next in Phase 1: from-conversation helper, more robust temporal, prepare for embedding.

## Phase 1 Complete

All core features from the roadmap are implemented and tested with real Google Drive storage.

**Ready for Phase 2**

## Phase 2 Complete

All Phase 2 features implemented and **tested** with Google Drive:
- Quality Scoring
- Conflict Detection
- Temporal Decay
- Auto-tagging
- Relationships
- Enhanced recall

Ready for Phase 3.

## Phase 3 Complete

Intelligence Layer fully implemented and tested:
- Daily reports
- Conflict resolution
- Relationship graphs
- Insights
- Health checks

Current: Up to Phase 3 complete. Roadmap has 5 phases total.

## Phase 4 Complete

Agent ecosystem features added and code updated:
- Agents
- File indexing
- Export/Backup
- Audit
- Enhanced graph

Roadmap now at Phase 4 complete. 1 phase left (Production).

## Phase 5: Production & Polish — COMPLETE

### Deployment to Vercel

This API is designed for Vercel (like Zenos Mail).

**Preparation:**
1. Set environment variables in Vercel dashboard:
   - `GOOGLE_SERVICE_ACCOUNT_KEY` = full JSON string of service account
   - `ZENOS_MEMORY_DRIVE_FOLDER_ID`
   - `ZENOS_MEMORY_API_KEY`
   - `USE_LOCAL_STORE=false`

**Deploy:**
```bash
npx vercel --prod --yes
# or with token
npx vercel --prod --token $VERCEL_TOKEN --yes
```

**Important:** Use KEY (string) not FILE on Vercel. Local storage does not persist.

### Rate Limiting
Basic 60 req/min per IP on main endpoints.

### Backup & Recovery
- `/api/memory/export`
- `/api/memory/backup`

### Full API List
See routes in app/api/memory/


## Security & Safe Deployment (IMPORTANT)

**Service Account Key Handling:**
- Never commit the JSON key or .env files.
- On VPS: use GOOGLE_SERVICE_ACCOUNT_FILE pointing to secure location.
- On Vercel: set GOOGLE_SERVICE_ACCOUNT_KEY as the full JSON **string** (not file).

**Safe Vercel Deploy:**
1. Add env vars in Vercel dashboard (KEY as string).
2. Use `./scripts/deploy-vercel.sh [token]`
3. Verify folder is shared with the service account.

All phases complete. System is production-ready with safety measures.
