"""
Build seed SQL for FCB Field Ops from:
  1. Base44 shipping exports (ShippingOrder / OrderLineItem / Product / Mold CSVs)
  2. A JSON transcription of the 10/29-10/30 paper work orders + schedules

Usage:
  python3 build_seed.py <csv_dir> <transcription.json> <out_dir>

Outputs:
  01_reference.sql          companies(+aliases), jobs(+aliases), products, shipments, lines, molds
  02_field_test.sql         employees(+aliases), crews, rosters, work orders, flags, notes, PW
  company_groups_review.csv proposed company merges for a human to approve
"""
import csv, glob, json, os, re, sys, uuid, collections, difflib, datetime as dt

csv_dir, trans_path, out_dir = sys.argv[1:4]
os.makedirs(out_dir, exist_ok=True)
NS = uuid.UUID("6f1c2d3e-0000-4000-8000-00000000fcb0")      # deterministic ids => re-runnable seed


def uid(*parts):
    return str(uuid.uuid5(NS, "|".join(map(str, parts))))


def norm(s):  # mirrors public.norm_name (unaccent + strip punctuation)
    import unicodedata
    s = "".join(c for c in unicodedata.normalize("NFKD", s or "") if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s.lower())).strip()


def prod_ref(raw):  # resolve inside Postgres so ids always exist
    return f"(select id from public.products where name_norm = public.norm_name({q(raw)}))"


def q(v):
    if v is None or v == "":
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def qj(d):
    return q(json.dumps(d)) + "::jsonb"


def qa(arr):
    return "'{" + ",".join('"%s"' % a.replace('"', '') for a in arr) + "}'"


def inserts(table, cols, rows, conflict="on conflict do nothing", batch=400):
    out = []
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        out.append(f"insert into public.{table} ({', '.join(cols)}) values\n  " +
                   ",\n  ".join("(" + ", ".join(r) + ")" for r in chunk) + f"\n{conflict};")
    return "\n".join(out)


def read(name):
    path = glob.glob(os.path.join(csv_dir, f"*{name}_export.csv"))[0]
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


orders, lines, products_csv, molds = read("ShippingOrder"), read("OrderLineItem"), read("Product"), read("Mold")

# ---------------------------------------------------------------------------
# COMPANIES — group spellings
# ---------------------------------------------------------------------------
LEGAL = r"\b(inc|llc|corp|corporation|co|company|ltd|the|of|lp)\b"


def company_key(raw):
    s = raw.split("\n")[0]
    s = re.split(r"\s\d{3,}\s|\sP\.?O\.? ?BOX", s, flags=re.I)[0]  # cut pasted addresses
    s = norm(s)
    s = s.replace("suppy", "supply").replace("reglonal", "regional").replace("tripointe", "tri pointe")
    s = re.sub(LEGAL, " ", s)
    s = re.sub(r"\bhomes?\b", "homes", s)
    return re.sub(r"\s+", " ", s).strip()


spellings = collections.Counter(o["customer_name"].strip() for o in orders if o["customer_name"].strip())
groups = collections.defaultdict(list)
for sp in spellings:
    groups[company_key(sp)].append(sp)

# fuzzy-merge keys that are near-identical (typos), never across different branch cities
keys = sorted(groups, key=lambda k: -sum(spellings[s] for s in groups[k]))
merged = {}
for k in keys:
    target = None
    for m in merged:
        if k.split()[:1] == m.split()[:1] and difflib.SequenceMatcher(None, k, m).ratio() >= 0.92:
            target = m
            break
    merged.setdefault(target or k, []).extend(groups[k])


def nice(sp):  # prefer mixed-case spelling without address
    return sp.split("\n")[0].strip(" .")


companies = {}       # key -> dict
alias_to_company = {}
review = []
for k, sps in merged.items():
    sps_sorted = sorted(sps, key=lambda s: (-spellings[s], s.isupper(), len(s)))
    mixed = [s for s in sps_sorted if not s.isupper() and "\n" not in s and not re.search(r"\d{4}", s)]
    canonical = nice((mixed or sps_sorted)[0])
    cid = uid("company", k)
    kinds = []
    if re.search(r"supply|ferguson|winsupply|slakey|consolidated|keller", k):
        kinds.append("supply_house")
    elif re.search(r"plumb|mechanical|ampam", k):
        kinds.append("plumber")
    elif re.search(r"homes|lennar|kb|tri pointe|taylor morrison|shea|meritage|beazer|richmond|century communities", k):
        kinds.append("builder")
    companies[k] = dict(id=cid, name=canonical, kinds=kinds, n=sum(spellings[s] for s in sps))
    for s in sps:
        alias_to_company[s] = cid
    review.append([canonical, len(sps), companies[k]["n"], " | ".join(s.replace("\n", " ") for s in sps_sorted)])

# ---------------------------------------------------------------------------
# JOBS — group per company
# ---------------------------------------------------------------------------
def job_key(raw):
    s = norm(raw)
    s = re.sub(r"\bapartments\b", "apts", s)
    s = re.sub(r"\b(turnkey)\b", "", s)
    return re.sub(r"\s+", " ", s).strip()


jobs = {}            # (cid, key) -> dict
job_spellings = collections.defaultdict(collections.Counter)
for o in orders:
    cid = alias_to_company.get(o["customer_name"].strip())
    if not cid:
        continue
    k = (cid, job_key(o["job_name"]))
    job_spellings[k][o["job_name"].strip()] += 1
    jobs.setdefault(k, dict(id=uid("job", *k), customer_id=cid, facility=collections.Counter()))
    jobs[k]["facility"][o["location"]] += 1
for k, j in jobs.items():
    sp = job_spellings[k]
    j["name"] = sorted(sp, key=lambda s: (-sp[s], s.isupper()))[0].replace("**", "").strip()
    j["aliases"] = [s for s in sp if norm(s) != norm(j["name"])]
    j["facility_code"] = j["facility"].most_common(1)[0][0]

# ---------------------------------------------------------------------------
# PRODUCTS
# ---------------------------------------------------------------------------
def parse_product(name):
    v = re.sub(r"\s+", " ", name.upper()).strip()
    series = (re.match(r"^[A-Z]+", v) or [None])[0]
    hand = "L" if re.search(r"\b(LH|L/H)\b", v) else "R" if re.search(r"\b(RH|R/H)\b", v) else None
    base = re.sub(r"\s*\b(LH|RH|L/H|R/H)\b\s*", " ", v).strip()
    return series, base, hand


products = {}
for name in [p["name"] for p in products_csv] + [l["product_name"] for l in lines]:
    n = norm(name)
    if not n:
        continue
    if n not in products:
        products[n] = dict(id=uid("product", n), name=re.sub(r"\s+", " ", name).strip(), legacy=[])
for p in products_csv:
    if norm(p["name"]) in products:
        products[norm(p["name"])]["legacy"].append(p["id"])

# ---------------------------------------------------------------------------
# WRITE 01_reference.sql
# ---------------------------------------------------------------------------
today = dt.date(2026, 11, 3)
ref = ["-- Generated by scripts/build_seed.py from Base44 exports. Safe to re-run (deterministic ids).",
       "begin;"]
ref.append(inserts("companies", ["id", "name", "kinds", "legacy_ids"],
                   [[q(c["id"]), q(c["name"]), qa(c["kinds"]), qj({"source": "base44_shipping"})]
                    for c in companies.values()]))
ref.append(inserts("company_aliases", ["company_id", "alias", "source"],
                   [[q(cid), q(a.replace("\n", " ")), q("import")] for a, cid in alias_to_company.items()]))
ref.append(inserts("jobs", ["id", "name", "customer_id", "facility_code", "legacy_ids"],
                   [[q(j["id"]), q(j["name"]), q(j["customer_id"]), q(j["facility_code"]),
                     qj({"source": "base44_shipping"})] for j in jobs.values()]))
ref.append(inserts("job_aliases", ["job_id", "alias", "source"],
                   [[q(j["id"]), q(a), q("import")] for j in jobs.values() for a in j["aliases"]]))
ref.append(inserts("products", ["id", "name", "series", "base_model", "hand", "legacy_ids"],
                   [[q(p["id"]), q(p["name"]), *map(q, parse_product(p["name"])), qj({"base44": p["legacy"]})]
                    for p in products.values()]))

ship_rows, order_ids = [], {}
for o in orders:
    cid = alias_to_company.get(o["customer_name"].strip())
    jk = (cid, job_key(o["job_name"]))
    sid = uid("shipment", o["id"])
    order_ids[o["id"]] = sid
    d = o["ship_date"][:10]
    status = "shipped" if d and dt.date.fromisoformat(d) < today else "scheduled"
    d = d or None
    if "BACKORDER" in o["notes"].upper():
        status = "backordered" if status == "scheduled" else status
    ship_rows.append([q(sid), q(o["job_id"]), q(jobs[jk]["id"] if jk in jobs else None), q(cid), q(o["location"]),
                      q(d), q(status), q(o["notes"]), q(o["customer_name"]), q(o["job_name"]),
                      qj({"base44": o["id"]}), q(o["created_date"])])
ref.append(inserts("shipments", ["id", "order_number", "job_id", "customer_id", "facility_code", "ship_date", "status",
                                 "notes", "raw_customer_name", "raw_job_name", "legacy_ids", "created_at"], ship_rows))
line_rows = []
for l in lines:
    if l["order_id"] not in order_ids:
        continue
    line_rows.append([q(uid("line", l["id"])), q(order_ids[l["order_id"]]),
                      prod_ref(l["product_name"]), q(l["product_name"]),
                      q(float(l["quantity"] or 0)), qj({"base44": l["id"]})])
ref.append(inserts("shipment_lines", ["id", "shipment_id", "product_id", "raw_product_name", "quantity", "legacy_ids"],
                   line_rows))
ref.append(inserts("molds", ["id", "mold_name", "mold_number", "position", "product_id", "raw_product_name",
                             "current_facility", "condition", "status", "flagged_for_repair",
                             "last_maintenance_date", "next_maintenance_due", "notes", "legacy_ids"],
                   [[q(uid("mold", m["id"])), q(m["mold_name"]), q(m["mold_number"]), q(m["position"]),
                     prod_ref(m["product_name"]), q(m["product_name"]),
                     q(m["current_location"]), q(m["condition"]), q(m["status"]), q(m["flagged_for_repair"] == "true"),
                     q(m["last_maintenance_date"]), q(m["next_maintenance_due"]), q(m["notes"]),
                     qj({"base44": m["id"]})] for m in molds]))
ref.append("commit;")
open(os.path.join(out_dir, "01_reference.sql"), "w").write("\n\n".join(ref) + "\n")

with open(os.path.join(out_dir, "company_groups_review.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["proposed_company_name", "spellings_merged", "shipping_orders", "all_spellings"])
    for r in sorted(review, key=lambda r: -r[2]):
        w.writerow(r)

# ---------------------------------------------------------------------------
# FIELD TEST DATA from the 10/29 - 10/30 paperwork
# ---------------------------------------------------------------------------
T = json.load(open(trans_path))

EMP = [  # canonical, position, dept, aliases as written on the sheets
    ("Gilberto Arellano", "lead", "install", ["GilbertoA", "Gilberto"]),
    ("Fernando Garcia", "helper", "install", ["Fernando"]),
    ("Jose Flores", "lead", "install", []),
    ("Anel Bautista", "helper", "install", ["Anel"]),
    ("Javier Jimenez", "lead", "install", ["Javir", "Javier"]),
    ("Jose Armenta", "helper", "install", []),
    ("Narciso Flores", "lead", "install", ["Naysiso", "Narsiso", "Narciso"]),
    ("Ascencion Perez", "lead", "install", ["Ascencion"]),
    ("Juan Godinez", "helper", "install", ["Juan Godines", "Godiner"]),
    ("Daniel Zavala", "lead", "install", ["Daniel"]),
    ("Oscar C.", "helper", "install", ["Oscas", "Oscar"]),
    ("Ivan T.", "helper", "install", ["Ivan"]),
    ("Roberto Martinez", "lead", "install", ["Roberto Mtz", "RobertoMtz"]),
    ("Jesus Reyes", "helper", "install", []),
    ("Agustin Contreras", "lead", "install", ["Agustin"]),
    ("Anthony Morales", "helper", "install", ["Anthony"]),
    ("Jose Rea", "lead", "stocking", []),
    ("Hugo Sosa", "helper", "stocking", []),
    ("Antonio Zavala", "helper", "stocking", []),
    ("Luis Amapa", "lead", "stocking", []),
    ("Fabian Reyes", "helper", "stocking", []),
    ("Jose Rios", "helper", "stocking", ["Jose Ros"]),
    ("Marco Valadez", "lead", "stocking", []),
    ("Juan Abarca", "helper", "stocking", []),
    ("Celso Cisneros", "helper", "stocking", []),
    ("Jesus Aceves", "helper", "stocking", []),
]
emp_id = {}
fs = ["-- Field Ops TEST data built from the 10/29-10/30/2026 paper work orders.",
      "-- Employee codes are placeholders (TEST-###) until the real employee list is imported.",
      "begin;"]
rows, arows = [], []
for i, (name, pos, dept, aliases) in enumerate(EMP, 1):
    first, *rest = name.split(" ", 1)
    eid = uid("employee", name)
    emp_id[name] = eid
    rows.append([q(eid), q(first), q(rest[0] if rest else None), q(f"TEST-{i:03d}"), q(pos), qa([dept]),
                 q("adelanto")])
    for a in aliases + [name.upper()]:
        arows.append([q(eid), q(a), q("import")])
fs.append(inserts("employees", ["id", "first_name", "last_name", "employee_code", "default_position", "departments",
                                "home_facility"], rows))
fs.append(inserts("employee_aliases", ["employee_id", "alias", "source"], arows))

CREWS = [  # name, dept, lead, helpers, color
    ("Gilberto", "install", "Gilberto Arellano", ["Fernando Garcia"], "#2563eb"),
    ("Jose F.", "install", "Jose Flores", ["Anel Bautista"], "#7c3aed"),
    ("Javier", "install", "Javier Jimenez", ["Jose Armenta"], "#0891b2"),
    ("Narciso", "install", "Narciso Flores", [], "#db2777"),
    ("Ascencion", "install", "Ascencion Perez", ["Juan Godinez"], "#ea580c"),
    ("Daniel", "install", "Daniel Zavala", ["Oscar C.", "Ivan T."], "#16a34a"),
    ("Roberto", "install", "Roberto Martinez", ["Jesus Reyes"], "#ca8a04"),
    ("Agustin", "install", "Agustin Contreras", ["Anthony Morales"], "#4f46e5"),
    ("Jose Rea", "stocking", "Jose Rea", ["Hugo Sosa", "Antonio Zavala"], "#059669"),
    ("Luis", "stocking", "Luis Amapa", ["Fabian Reyes", "Jose Rios"], "#0d9488"),
    ("Marco", "stocking", "Marco Valadez", ["Juan Abarca", "Celso Cisneros", "Jesus Aceves"], "#65a30d"),
]
crew_id = {}
crow, mrow = [], []
for i, (cname, dept, lead, helpers, color) in enumerate(CREWS):
    cid = uid("crew", cname)
    crew_id[cname] = cid
    crow.append([q(cid), q(cname), q(dept), q(color), q(i)])
    mrow.append([q(cid), q(emp_id[lead]), q("lead")])
    for h in helpers:
        mrow.append([q(cid), q(emp_id[h]), q("helper")])
fs.append(inserts("crews", ["id", "name", "department", "color", "sort_order"], crow))
fs.append(inserts("crew_default_members", ["crew_id", "employee_id", "position"], mrow))


# --- jobs for the paperwork: link to shipping jobs where they exist -------
def find_job(cust_kw, job_kw):
    best = None
    for (cid, k), j in jobs.items():
        cname = next(c["name"] for c in companies.values() if c["id"] == cid)
        if cust_kw in norm(cname) and re.search(r"\b" + re.escape(job_kw) + r"\b", k):
            if best is None or len(k) < len(best[1]):
                best = (j, k)
    return best[0] if best else None


extra_companies, extra_jobs = {}, {}


def get_company(name, kinds):
    for c in companies.values():
        if norm(c["name"]) == norm(name):
            return c["id"]
    cid = uid("company", "field", name)
    extra_companies[cid] = (name, kinds)
    return cid


FIELD_JOBS = {  # key: (customer kw, job kw) -> fallback (customer, job name)
    "delamo": ("century west", "del amo", "Century West Plumbing", "Del Amo"),
    "woodman": ("alpa", "woodman", "Alpa Construction", "Woodman"),
    "sepulveda": ("century west", "6728", "Century West Plumbing", "6728 Sepulveda Blvd"),
    "discovery": ("western national", "discovery park", "Western National Contractors", "Discovery Park"),
    "oro": ("lennar", "oro mesa", "Lennar", "Oro Mesa Verde"),
    "6thpalm": ("sherwood", "palm", "Sherwood Mechanical Inc.", "6th & Palm"),
    "harvest": ("lennar", "harvest", "Lennar", "Harvest"),
    "deanza": ("monte vista", "anza", "Monte Vista Homes", "De Anza Villas"),
    "skyline": ("lennar", "skyline", "Lennar", "Skyline"),
    "outbound": ("lennar", "outbound", "Lennar", "Outbound"),
    "bellamy": ("production plus", "bellamy", "Production Plus Plumbing", "Bellamy"),
    "fountain": ("mg plumbing", "fountain valley", "MG Plumbing", "Fountain Valley Apts."),
    "slauson": ("hydroflow", "slauson", "Hydroflow Fire Protection", "3455 Slauson Ave."),
    "ashbury": ("new home", "ashbury", "New Home Co.", "Ashbury"),
}
CITIES = {"delamo": "Torrance", "woodman": "Van Nuys", "sepulveda": "Van Nuys", "discovery": "Irvine",
          "oro": "San Diego", "6thpalm": "San Diego", "harvest": "Jurupa Valley", "deanza": "Riverside",
          "skyline": "Jurupa Valley", "outbound": "Rialto", "bellamy": "Agoura Hills", "fountain": "Long Beach",
          "slauson": "Los Angeles", "ashbury": "Eastvale"}
field_job = {}
city_updates = []
for key, (ckw, jkw, cname, jname) in FIELD_JOBS.items():
    j = find_job(ckw, jkw)
    if j:
        field_job[key] = j["id"]
    else:
        cid = get_company(cname, ["builder"] if "Lennar" in cname or "Homes" in cname else ["plumber"])
        jid = uid("job", "field", key)
        extra_jobs[jid] = (jname, cid)
        field_job[key] = jid
    city_updates.append(f"update public.jobs set city = {q(CITIES[key])} where id = {q(field_job[key])} and city is null;")

fs.append(inserts("companies", ["id", "name", "kinds"],
                  [[q(i), q(n), qa(k)] for i, (n, k) in extra_companies.items()]))
fs.append(inserts("jobs", ["id", "name", "customer_id", "facility_code"],
                  [[q(i), q(n), q(c), q("adelanto")] for i, (n, c) in extra_jobs.items()]))
fs.append("\n".join(city_updates))

# JR Pierce / Shea example of extra parties
shea = find_job("slakey", "shea portola")
if shea:
    pierce = get_company("JR Pierce Plumbing", ["contractor"])
    sheaco = next((c["id"] for c in companies.values() if norm(c["name"]).startswith("shea homes")), None)
    fs.append(inserts("companies", ["id", "name", "kinds"], [[q(pierce), q("JR Pierce Plumbing"), qa(["contractor"])]]))
    fs.append(inserts("job_parties", ["job_id", "company_id", "role"],
                      [[q(shea["id"]), q(pierce), q("contractor")]] +
                      ([[q(shea["id"]), q(sheaco), q("builder")]] if sheaco else [])))
    fs.append(f"update public.jobs set city = 'Livermore' where id = {q(shea['id'])};")

# Prevailing wage: Fountain Valley Apts is PW
fs.append(inserts("prevailing_wage_periods", ["id", "job_id", "effective_from", "source_note"],
                  [[q(uid("pw", "fountain")), q(field_job["fountain"]), q("2026-09-01"),
                    q("TEST — flagged PW on 10/30 stocking sheets")]]))

# --- crew days + work orders ---------------------------------------------
FORM_MAP = {  # (file, page) -> (job key, crew, sequence, type)
    ("install", 3): ("delamo", "Gilberto", 1, "IN"), ("install", 4): ("woodman", "Jose F.", 1, "IN"),
    ("install", 5): ("sepulveda", "Javier", 1, "IN"), ("install", 6): ("discovery", "Narciso", 1, "IN"),
    ("install", 7): ("delamo", "Narciso", 2, "IN"), ("install", 8): ("oro", "Ascencion", 1, "IN"),
    ("install", 9): ("6thpalm", "Ascencion", 2, "IN"), ("install", 10): ("harvest", "Daniel", 1, "IN"),
    ("install", 11): ("deanza", "Daniel", 2, "IN"), ("install", 12): ("skyline", "Roberto", 1, "IN"),
    ("install", 13): ("outbound", "Roberto", 2, "IN"), ("install", 14): ("bellamy", "Agustin", 1, "IN"),
    ("stocking", 2): ("fountain", "Jose Rea", 1, "ST"), ("stocking", 3): ("slauson", "Jose Rea", 2, "ST"),
    ("stocking", 4): ("fountain", "Luis", 1, "ST"), ("stocking", 5): ("slauson", "Luis", 2, "ST"),
    ("stocking", 6): ("ashbury", "Marco", 1, "ST"), ("stocking", 7): ("discovery", "Marco", 2, "ST"),
}
FLAG_MAP = {"repair_needed": "repair_needed", "no_signature": "no_signature", "photos_sent_offline": "photos_offline",
            "partial": "partial", "not_ready": "not_ready", "wrong_hand": "wrong_hand", "missing_parts": "missing_parts",
            "rework": "repair_needed", "delivery_refused": "not_ordered", "material_returned": "not_ordered"}


def t24(s, pm_hint=False):
    m = re.search(r"(\d{1,2}):(\d{2})", s or "")
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if ("PM" in (s or "").upper() or (pm_hint and h < 7)) and h < 12:
        h += 12
    return f"{h:02d}:{mi:02d}"


def line_status(s):
    s = (s or "").lower()
    return ("stockpiled" if "pile" in s else "room_in" if "room" in s else "returned" if "return" in s
            else "done")


cd_rows, cdm_rows, stop_rows, wo_rows, line_rows, flag_rows, worker_rows, note_rows, seqs = [], [], [], [], [], [], [], [], collections.Counter()
crew_days = {}
for (cname, dept, lead, helpers, _) in CREWS:
    date = "2026-10-29" if dept == "install" else "2026-10-30"
    cdid = uid("crewday", cname, date)
    crew_days[cname] = (cdid, date)
    cd_rows.append([q(cdid), q(crew_id[cname]), q(date)])
    cdm_rows.append([q(cdid), q(date), q(emp_id[lead]), q("lead"), q("present")])
    for h in helpers:
        cdm_rows.append([q(cdid), q(date), q(emp_id[h]), q("helper"), q("present")])

for r in T:
    key = (r.get("file"), r.get("page"))
    if key not in FORM_MAP:
        continue
    jkey, cname, seq, typ = FORM_MAP[key]
    cdid, date = crew_days[cname]
    seqs[(typ, date[:4])] += 1
    number = f"{typ}-26-{9000 + len(wo_rows) + 1:04d}"           # test range 9000+
    woid = uid("wo", *key)
    flags = [FLAG_MAP[f] for f in r.get("flags") or [] if f in FLAG_MAP]
    canceled = "canceled" in (r.get("flags") or []) or (r.get("lines") == [] and "not_ready" in flags)
    status = "canceled" if canceled else "complete"
    if "no_signature" in flags and r.get("superintendent_signed"):
        flags.remove("no_signature")
    wo_rows.append([q(woid), q(number), q(typ), q(field_job[jkey]), q(status),
                    q(r.get("notes_english") if canceled else None), q(date),
                    q(f"{'Install' if typ == 'IN' else 'Stock'} — {r.get('phase_or_building') or 'per order'}"),
                    q("order"), q(True), q(t24(r.get("time_in"))), q(t24(r.get("time_out"), True)),
                    q(r.get("notes_original")), q(r.get("notes_english")),
                    q(bool(r.get("superintendent_signed"))), qj({"paper": f"{key[0]} p{key[1]}"})])
    stop_rows.append([q(uid("stop", *key)), q(cdid), q(woid), q(seq)])
    for i, l in enumerate(r.get("lines") or []):
        line_rows.append([q(uid("woline", *key, i)), q(woid), q(str(l.get("lot") or "").replace("?", "")),
                          q(l.get("form_column")), q(l.get("product_or_sku")),
                          q(l.get("hand") if l.get("hand") in ("L", "R") else None),
                          q(l.get("qty") or 1), q(l.get("qty") or 1), q(line_status(l.get("status"))), q(i)])
    for f in dict.fromkeys(flags):
        flag_rows.append([q(uid("flag", *key, f)), q(woid), q(f), q(r.get("notes_english") if f != "no_signature" else None)])
    # workers exactly as written -> exercise the matcher
    names = [(r.get("lead"), "lead")] + [(h, "helper") for h in r.get("helpers") or []]
    for n, pos in names:
        if not n:
            continue
        raw = n.replace("?", "").strip()
        match = next((emp_id[e[0]] for e in EMP if norm(raw) in [norm(a) for a in e[3] + [e[0], e[0].split()[0]]]
                      and not (norm(raw) == "jose" and e[0] != ("Jose Flores" if cname == "Jose F." else "Jose Armenta"))),
                     None)
        worker_rows.append([q(uid("worker", *key, raw)), q(woid), q(match), q(n), q(pos), q("scan"),
                            q(0.95 if match else None)])
    if r.get("notes_original"):
        note_rows.append([q(uid("note", *key)), q(woid), q("Crew note (from paper): " + r["notes_original"]),
                          q("es"), q(r.get("notes_english"))])

fs.append(inserts("crew_days", ["id", "crew_id", "work_date"], cd_rows))
fs.append(inserts("crew_day_members", ["crew_day_id", "work_date", "employee_id", "position", "status"], cdm_rows))
fs.append(inserts("work_orders", ["id", "number", "type_code", "job_id", "status", "status_reason", "scheduled_date",
                                  "scope", "source", "crew_on_site", "time_in", "time_out", "completion_notes",
                                  "completion_notes_en", "superintendent_signed", "legacy_ids"], wo_rows))
fs.append(inserts("crew_day_stops", ["id", "crew_day_id", "work_order_id", "sequence"], stop_rows))
fs.append(inserts("work_order_lines", ["id", "work_order_id", "lot_label", "room", "raw_product", "hand",
                                       "qty_planned", "qty_done", "status", "sort_order"], line_rows))
fs.append(inserts("work_order_flags", ["id", "work_order_id", "flag_code", "note"], flag_rows))
fs.append(inserts("work_order_workers", ["id", "work_order_id", "employee_id", "raw_name", "position", "source",
                                         "match_confidence"], worker_rows))
fs.append(inserts("notes", ["id", "work_order_id", "body", "body_language", "body_translated"], note_rows))

# Follow-up: Discovery Park not ready -> come back next Tuesday (11/3)
fs.append(f"""insert into public.work_orders (id, number, type_code, job_id, status, scheduled_date, scope, parent_id, follow_up_suffix, source)
values ({q(uid('wo', 'discovery-followup'))}, 'IN-26-9004-B', 'IN', {q(field_job['discovery'])}, 'planned', '2026-11-03',
        'Return — install once waterproofing is up (Edgar said Tuesday)', {q(uid('wo', 'install', 6))}, 'B', 'follow_up')
on conflict do nothing;""")
fs.append("commit;")
open(os.path.join(out_dir, "02_field_test.sql"), "w").write("\n\n".join(fs) + "\n")

print(f"companies {len(companies)} (from {len(spellings)} spellings) | jobs {len(jobs)} | products {len(products)} | "
      f"shipments {len(ship_rows)} | lines {len(line_rows)} (wo) | WOs {len(wo_rows)} | employees {len(EMP)}")
