import json, sqlite3, os, time

BASE = os.path.dirname(__file__)
DB = os.path.join(BASE, 'data.db')

if os.path.exists(DB):
    os.remove(DB)

conn = sqlite3.connect(DB)
conn.execute('PRAGMA journal_mode=WAL')
conn.execute("CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL DEFAULT '{}')")
conn.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}')")
conn.execute("""CREATE TABLE media_blobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
)""")
conn.execute("INSERT OR IGNORE INTO settings (id, data) VALUES (1, '{}')")

# Migrate settings
sf = os.path.join(BASE, 'settings.json')
if os.path.exists(sf):
    with open(sf, 'r', encoding='utf-8') as f:
        settings = json.load(f)
    conn.execute('UPDATE settings SET data=? WHERE id=1', (json.dumps(settings, ensure_ascii=False),))
    print(f'Settings: {len(settings)} keys')

# Migrate projects
proj_dir = os.path.join(BASE, 'projects')
if os.path.isdir(proj_dir):
    for pid in os.listdir(proj_dir):
        pf = os.path.join(proj_dir, pid, 'project.json')
        if os.path.isfile(pf):
            with open(pf, 'r', encoding='utf-8') as f:
                proj = json.load(f)
            conn.execute('INSERT OR REPLACE INTO projects (id, data) VALUES (?, ?)',
                         (pid, json.dumps(proj, ensure_ascii=False)))
            lib = proj.get('mediaLibrary', [])
            print(f'Project: {proj.get("name", pid)} (media: {len(lib)})')

# Import existing media files into SQLite BLOBs
media_dir = os.path.join(BASE, 'media')
blob_count = 0
if os.path.isdir(media_dir):
    for pid in os.listdir(media_dir):
        proj_media = os.path.join(media_dir, pid)
        if not os.path.isdir(proj_media):
            continue
        for mtype in os.listdir(proj_media):
            type_dir = os.path.join(proj_media, mtype)
            if not os.path.isdir(type_dir):
                continue
            for fn in os.listdir(type_dir):
                fpath = os.path.join(type_dir, fn)
                if not os.path.isfile(fpath):
                    continue
                ext = fn.split('.')[-1].lower()
                mime_map = {'png': 'image/png', 'jpg': 'image/jpeg', 'wav': 'audio/wav', 'mp3': 'audio/mpeg'}
                mime = mime_map.get(ext, 'application/octet-stream')
                with open(fpath, 'rb') as f:
                    data = f.read()
                conn.execute(
                    "INSERT INTO media_blobs (project_id, media_type, filename, mime, data, created_at) VALUES (?,?,?,?,?,?)",
                    (pid, mtype, fn, mime, data, int(os.path.getmtime(fpath) * 1000))
                )
                blob_count += 1
                print(f'  BLOB: {fn} ({len(data):,} bytes)')

conn.commit()
conn.close()

# Verify
conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
s = json.loads(conn.execute("SELECT data FROM settings WHERE id=1").fetchone()[0])
p_count = conn.execute("SELECT COUNT(*) as c FROM projects").fetchone()[0]
b_count = conn.execute("SELECT COUNT(*) as c FROM media_blobs").fetchone()[0]
print(f'\nDone! Settings={len(s)}keys Projects={p_count} Blobs={b_count}')
conn.close()
