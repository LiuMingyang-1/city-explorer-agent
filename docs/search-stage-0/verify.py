"""Offline design checks; only schema keywords used by these artifacts are supported."""
import copy
import datetime
import json
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parent
load = lambda name: json.loads((ROOT / name).read_text(encoding="utf-8"))
request = load("request.schema.json")
response = load("response.schema.json")

def validate(value, schema):
    if "$ref" in schema:
        assert schema["$ref"] == "request.schema.json"
        return validate(value, request)
    if "anyOf" in schema:
        for option in schema["anyOf"]:
            try:
                validate(value, option)
                return
            except (AssertionError, ValueError):
                pass
        raise ValueError("no anyOf variant matched")
    types = schema.get("type")
    if types:
        types = [types] if isinstance(types, str) else types
        matches = {"object": isinstance(value, dict), "array": isinstance(value, list),
                   "string": isinstance(value, str), "null": value is None,
                   "integer": type(value) is int, "number": type(value) in (int, float),
                   "boolean": type(value) is bool}
        assert any(matches[t] for t in types), (value, types)
    if "enum" in schema: assert value in schema["enum"]
    if "const" in schema: assert value == schema["const"]
    if isinstance(value, dict):
        assert all(k in value for k in schema.get("required", []))
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False: assert not (value.keys() - props.keys())
        for k, v in value.items():
            if k in props: validate(v, props[k])
    if isinstance(value, list):
        assert len(value) >= schema.get("minItems", 0)
        assert len(value) <= schema.get("maxItems", float("inf"))
        if schema.get("uniqueItems"): assert len({json.dumps(v, sort_keys=True) for v in value}) == len(value)
        for v in value: validate(v, schema.get("items", {}))
    if isinstance(value, str):
        assert len(value) >= schema.get("minLength", 0)
        assert len(value) <= schema.get("maxLength", float("inf"))
        if "pattern" in schema: assert re.search(schema["pattern"], value)
    if type(value) in (int, float):
        assert value >= schema.get("minimum", -float("inf"))
        assert value <= schema.get("maximum", float("inf"))

def check_request(r):
    validate(r, request)
    if "date" in r: datetime.date.fromisoformat(r["date"])
    for key in ("keyword", "category"):
        if key in r: assert r[key].strip()

def check_response(r):
    validate(r, response)
    check_request(r["effective_request"])
    assert r["partial"] == (r["status"] == "partial")
    if r["next_cursor"] is not None: assert r["truncated"]
    if r["status"] == "success":
        assert not r["errors"] and any(c["status"] == "success" for c in r["coverage"])
    if r["status"] == "failed":
        assert not r["results"] and r["errors"]
        assert not any(c["status"] == "success" for c in r["coverage"])
    if r["status"] == "partial": assert r["errors"] or any(c["status"] != "success" for c in r["coverage"])
    ids = []
    for hit in r["results"]:
        ids.append(hit["result_id"])
        assert hit["city_status"] != "outside"
        if hit["kind"] == "document":
            assert hit["event"] is None and not hit["plannable"]
            assert hit["document_id"] == hit["result_id"] and hit["document_id"]
        else:
            e = hit["event"]
            assert e and hit["plannable"] and hit["result_id"] == e["event_id"]
            assert hit["city_status"] == "confirmed"
            if "date" in r["effective_request"]: assert hit["date_status"] == "confirmed"
            assert datetime.datetime.fromisoformat(e["start_at"]) < datetime.datetime.fromisoformat(e["end_at"])
            if e["budget_min"] is not None and e["budget_max"] is not None: assert e["budget_min"] <= e["budget_max"]
            if "legacy_unverified" not in hit["limitations"]:
                assert e["source_url"] and e["verified_at"] and e["fresh_until"]
    assert len(ids) == len(set(ids))

cases = load("examples.json")
for case in cases:
    check_request(case["request"])
    check_response(case["response"])

negative = []
for bad in ({"date":"2026-02-30"},{"limit":51},{"keyword":"  "},{"platforms":["fake"]},{"city":"北京"}):
    negative.append((check_request,bad))
b = copy.deepcopy(cases[1]["response"]); b["results"][0]["plannable"] = True; negative.append((check_response,b))
b = copy.deepcopy(cases[2]["response"]); b["results"][0]["event"]["source_url"] = None; negative.append((check_response,b))
b = copy.deepcopy(cases[0]["response"]); b["next_cursor"] = "hidden"; negative.append((check_response,b))
for check, bad in negative:
    try: check(bad)
    except (AssertionError,ValueError): continue
    raise AssertionError("negative example unexpectedly accepted")

# Existing events DDL is read from its current source; schema.ts interpolation is reconstructed.
src = ROOT.parent.parent / "src/data/schema.ts"
text = src.read_text(encoding="utf-8")
base_section = text.split("const BASE_EVENT_COLUMNS")[1].split("];",1)[0]
base_columns = re.findall(r'^  "(.*)",$', base_section, re.M)
assert len(base_columns) == 11
# Match actual added definitions including multi-line string formatting.
added_section = text.split("export const ADDED_EVENT_COLUMNS")[1].split("/** 完整建表",1)[0]
added = re.findall(r'definition:\s*"([^"\n]*(?:\\.[^"\n]*)*)"', added_section)
assert len(added) == 7
with sqlite3.connect(":memory:") as db:
    db.execute("CREATE TABLE events (" + ",".join(base_columns + added) + ")")
    db.execute("INSERT INTO events(id,title,description,category,venue_name,address,latitude,longitude,start_at,end_at,suggested_duration_minutes,guide_url) VALUES ('legacy','t','d','c','v','a',34,108,'2026-11-14T10:00','2026-11-14T17:00',90,'https://example.com/guide')")
    db.commit()
    db.executescript((ROOT / "schema.draft.sql").read_text(encoding="utf-8"))
    assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert db.execute("SELECT id,guide_url,source_url,status FROM events").fetchone() == ('legacy','https://example.com/guide',None,'legacy')
    assert not db.execute("PRAGMA foreign_key_check").fetchall()
    def rejected(sql):
        try: db.execute(sql)
        except sqlite3.IntegrityError: return
        raise AssertionError("SQL constraint missing")
    rejected("INSERT INTO search_run_results VALUES ('r','missing','missing',NULL,'fake','q',1,'s',1)")
    rejected("INSERT INTO search_runs(id,request_json,request_key,mode,status,expires_at,started_at) VALUES ('bad','invalid','k','local','success','x','x')")
    db.execute("INSERT INTO search_documents(id,platform,canonical_url,title,snippet,first_seen_at,last_fetched_at,fetch_status) VALUES ('d','web','https://example.com/a','t','s','x','x','snippet_only')")
    rejected("INSERT INTO search_documents(id,platform,canonical_url,title,snippet,first_seen_at,last_fetched_at,fetch_status) VALUES ('d2','web','https://example.com/a','t','s','x','x','snippet_only')")
print(f"PASS: {len(cases)} contract examples, {len(negative)} rejected examples, draft SQLite DDL and migration preservation/constraints")
