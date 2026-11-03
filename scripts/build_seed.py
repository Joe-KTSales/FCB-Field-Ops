"""
Build seed SQL for FCB Field Ops from:
  1. Base44 shipping exports (ShippingOrder / OrderLineItem / Product / Mold CSVs)
  2. A JSON transcription of the 10/29-10/30 paper work orders + schedules

  3. The employee list (xlsx: First Name, Last Name, Potential Alias, Department)
  4. The prevailing wage job list (xlsx: Customer, Job — "NAME, address, City, ST zip")

Usage:
  python3 build_seed.py <csv_dir> <transcription.json> <employees.xlsx> <pw.xlsx> <out_dir>

Outputs (each small enough to paste into the Supabase SQL editor; run in order):
  01_customers_jobs_products.sql   companies(+aliases), jobs(+aliases), products, molds
  02_shipments_partN.sql           shipping history from Base44, split into parts
  03_employees_crews.sql           real employees (+handwriting aliases), usual crews
  04_prevailing_wage.sql           PW jobs matched/created and flagged
  05_test_day_oct29_30.sql         the 10/29-10/30 paperwork as work orders (test data)
  99_remove_test_day.sql           removes only the test-day work orders/rosters
  company_groups_review.csv        how customer spellings were grouped
  pw_import_review.csv             how each PW line was matched
"""
import csv, glob, json, os, re, sys, uuid, collections, difflib, datetime as dt

csv_dir, trans_path, emp_path, pw_path, out_dir = sys.argv[1:6]
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
# helpers for paste-sized files
# ---------------------------------------------------------------------------
MAX_FILE = 900_000          # bytes; comfortable for the Supabase SQL editor
today = dt.date(2026, 11, 3)


def write(name, parts, header):
    body = "\n\n".join([f"-- {header}", "-- Generated by scripts/build_seed.py. Safe to re-run: existing rows are skipped.", "begin;"] + parts + ["commit;"]) + "\n"
    open(os.path.join(out_dir, name), "w").write(body)
    return len(body.encode())


def values_insert(table, cols, rows, select_sql, conflict="on conflict do nothing"):
    """insert ... select <select_sql> from (values ...) v(cols) — keeps lookups server-side and rows short."""
    out = []
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        out.append(f"insert into public.{table}\n{select_sql}\nfrom (values\n  " + ",\n  ".join("(" + ", ".join(r) + ")" for r in chunk) +
                   f"\n) v({', '.join(cols)})\n{conflict};")
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 01 customers, jobs, products, molds
# ---------------------------------------------------------------------------
p1 = [
    inserts("companies", ["id", "name", "kinds", "legacy_ids"],
            [[q(c["id"]), q(c["name"]), qa(c["kinds"]), qj({"source": "base44_shipping"})] for c in companies.values()]),
    inserts("company_aliases", ["company_id", "alias", "source"],
            [[q(cid), q(a.replace("\n", " ")), q("import")] for a, cid in alias_to_company.items()]),
    inserts("jobs", ["id", "name", "customer_id", "facility_code", "legacy_ids"],
            [[q(j["id"]), q(j["name"]), q(j["customer_id"]), q(j["facility_code"]), qj({"source": "base44_shipping"})] for j in jobs.values()]),
    inserts("job_aliases", ["job_id", "alias", "source"],
            [[q(j["id"]), q(a), q("import")] for j in jobs.values() for a in j["aliases"]]),
    inserts("products", ["id", "name", "series", "base_model", "hand", "legacy_ids"],
            [[q(p["id"]), q(p["name"]), *map(q, parse_product(p["name"])), qj({"base44": p["legacy"]})] for p in products.values()]),
    "",  # molds: filled in below
]
# molds are few; plain insert with a lookup is clearer
p1[-1] = inserts("molds", ["id", "mold_name", "mold_number", "position", "product_id", "raw_product_name", "current_facility",
                           "condition", "status", "flagged_for_repair", "last_maintenance_date", "next_maintenance_due", "notes", "legacy_ids"],
                 [[q(uid("mold", m["id"])), q(m["mold_name"]), q(m["mold_number"]), q(m["position"]), prod_ref(m["product_name"]),
                   q(m["product_name"]), q(m["current_location"]), q(m["condition"]), q(m["status"]), q(m["flagged_for_repair"] == "true"),
                   q(m["last_maintenance_date"]), q(m["next_maintenance_due"]), q(m["notes"]), qj({"base44": m["id"]})] for m in molds])
sizes = {"01_customers_jobs_products.sql": write("01_customers_jobs_products.sql", p1, "1 of 5 · Customers, jobs, products and molds from the shipping app")}

# ---------------------------------------------------------------------------
# 02 shipments + lines, split into parts (each shipment travels with its lines)
# ---------------------------------------------------------------------------
lines_by_order = collections.defaultdict(list)
for l in lines:
    lines_by_order[l["order_id"]].append(l)

ship_cols = ["i", "o", "j", "c", "f", "d", "s", "n", "rc", "rj", "b", "ca"]
ship_select = ("(id, order_number, job_id, customer_id, facility_code, ship_date, status, notes, raw_customer_name, raw_job_name, legacy_ids, created_at)\n"
               "select v.i::uuid, v.o, v.j::uuid, v.c::uuid, v.f, v.d::date, v.s::public.shipment_status, v.n, v.rc, v.rj, jsonb_build_object('base44', v.b), v.ca::timestamptz")
line_cols = ["i", "s", "r", "qty"]
line_select = ("(id, shipment_id, product_id, raw_product_name, quantity)\n"
               "select v.i::uuid, v.s::uuid, p.id, v.r, v.qty::numeric")
line_join = "left join public.products p on p.name_norm = public.norm_name(v.r)"

part, part_ships, part_lines, part_size, n_ships, n_lines = 1, [], [], 0, 0, 0
part_files = []


def flush():
    global part, part_ships, part_lines, part_size
    if not part_ships:
        return
    name = f"02_shipments_part{part}.sql"
    body = [values_insert("shipments", ship_cols, part_ships, ship_select)]
    lines_sql = values_insert("shipment_lines", line_cols, part_lines, line_select, conflict="")
    # add the product join + conflict to each lines statement
    lines_sql = lines_sql.replace("\n);", "\n);").replace(f") v({', '.join(line_cols)})\n;", f") v({', '.join(line_cols)})\n{line_join}\non conflict do nothing;")
    body.append(lines_sql)
    part_files.append(name)
    sizes[name] = write(name, body, f"2 of 5 · Shipping history, part {part}")
    part += 1
    part_ships, part_lines, part_size = [], [], 0


for o in orders:
    cid = alias_to_company.get(o["customer_name"].strip())
    jk = (cid, job_key(o["job_name"]))
    sid = uid("shipment", o["id"])
    d = o["ship_date"][:10]
    status = "shipped" if d and dt.date.fromisoformat(d) < today else "scheduled"
    if "BACKORDER" in o["notes"].upper() and status == "scheduled":
        status = "backordered"
    row = [q(sid), q(o["job_id"]), q(jobs[jk]["id"] if jk in jobs else None), q(cid), q(o["location"]), q(d or None), q(status),
           q(o["notes"]), q(o["customer_name"]), q(o["job_name"]), q(o["id"]), q(o["created_date"])]
    lrows = [[q(uid("line", l["id"])), q(sid), q(l["product_name"]), q(float(l["quantity"] or 0))] for l in lines_by_order[o["id"]]]
    est = sum(len(", ".join(r)) + 6 for r in [row] + lrows)
    if part_size + est > MAX_FILE - 20_000:
        flush()
    part_ships.append(row)
    part_lines.extend(lrows)
    part_size += est
    n_ships += 1
    n_lines += len(lrows)
flush()

with open(os.path.join(out_dir, "company_groups_review.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["proposed_company_name", "spellings_merged", "shipping_orders", "all_spellings"])
    for r in sorted(review, key=lambda r: -r[2]):
        w.writerow(r)

# ---------------------------------------------------------------------------
# 03 employees (real list) + usual crews
# ---------------------------------------------------------------------------
import openpyxl  # noqa: E402

DEPT_CODE = {
    "Southern California/Installation": "socal-install", "Southern California/Stocking": "socal-stocking",
    "Southern California/Finals": "socal-finals", "Southern California/Customer Service": "socal-cs",
    "Northern California/Installation": "norcal-install", "Las Vegas/Installation": "lv-install",
}
# how names were actually written on the 10/29-10/30 sheets (+ short forms that are unique on the roster)
HANDWRITING = {
    "Gilberto Arellano": ["GilbertoA", "Gilberto"], "Fernando Garcia Lopez": ["Fernando", "Fernando Garcia"],
    "Jose Flores-Zamarripa": ["Jose Flores"], "Anel Bautista": ["Anel"], "Francisco Javier Jimenez": ["Javir", "Javier Jimenez"],
    "Narciso Flores": ["Naysiso", "Narsiso", "Narciso"], "Ascencion Perez": ["Ascencion"],
    "Juan Godinez": ["Juan Godines", "Godiner"], "Daniel Zabala": ["Daniel", "Daniel Zavala"],
    "Oscar Cardoso": ["Oscar", "Oscas", "Oscar C"], "Ivan Trujillo": ["Ivan", "Ivan T"],
    "Roberto Martinez": ["Roberto Mtz", "RobertoMtz"], "Agustin Contreras": ["Agustin"],
    "Jose Rios-Calderon": ["Jose Rios", "Jose Ros"], "Marco Valadez Gutierrez": ["Marco Valadez", "Marco"],
}
wb = openpyxl.load_workbook(emp_path, data_only=True)
EMP = []
for r in list(wb.worksheets[0].iter_rows(min_row=2, values_only=True)):
    if not r or not r[0]:
        continue
    first, last, alias, dept = (str(x).strip() if x else "" for x in r[:4])
    full = f"{first} {last}".strip()
    EMP.append(dict(first=first, last=last or None, full=full, dept=DEPT_CODE.get(dept), alias=[a.strip() for a in alias.split(",") if a.strip()]))

CREWS = [  # name, dept, lead, helpers, color  (pairings from the 10/29-10/30 schedules)
    ("Gilberto", "socal-install", "Gilberto Arellano", ["Fernando Garcia Lopez"], "#2563eb"),
    ("Jose F.", "socal-install", "Jose Flores-Zamarripa", ["Anel Bautista"], "#7c3aed"),
    ("Javier", "socal-install", "Francisco Javier Jimenez", ["Jose Armenta"], "#0891b2"),
    ("Narciso", "socal-install", "Narciso Flores", [], "#db2777"),
    ("Ascencion", "socal-install", "Ascencion Perez", ["Juan Godinez"], "#ea580c"),
    ("Daniel", "socal-install", "Daniel Zabala", ["Oscar Cardoso", "Ivan Trujillo"], "#16a34a"),
    ("Roberto", "socal-install", "Roberto Martinez", ["Jesus Reyes"], "#ca8a04"),
    ("Agustin", "socal-install", "Agustin Contreras", ["Anthony Morales"], "#4f46e5"),
    ("Jose Rea", "socal-stocking", "Jose Rea", ["Hugo Sosa", "Antonio Zavala"], "#059669"),
    ("Luis", "socal-stocking", "Luis Amapa", ["Fabian Reyes", "Jose Rios-Calderon"], "#0d9488"),
    ("Marco", "socal-stocking", "Marco Valadez Gutierrez", ["Juan Abarca", "Celso Cisneros", "Jesus Aceves"], "#65a30d"),
]
leads = {c[2] for c in CREWS}
emp_id = {e["full"]: uid("employee", e["full"]) for e in EMP}
for c in CREWS:
    for n in [c[2], *c[3]]:
        assert n in emp_id, f"crew member {n} not on the employee list"

erows, arows = [], []
for e in EMP:
    erows.append([q(emp_id[e["full"]]), q(e["first"]), q(e["last"]), q("lead" if e["full"] in leads else "helper"),
                  qa([e["dept"]] if e["dept"] else []), q("adelanto" if (e["dept"] or "").startswith("socal") else None)])
    for a in dict.fromkeys(e["alias"] + HANDWRITING.get(e["full"], [])):
        arows.append([q(emp_id[e["full"]]), q(a), q("import")])
crow, mrow = [], []
crew_id = {}
for i, (cname, dept, lead, helpers, color) in enumerate(CREWS):
    crew_id[cname] = uid("crew", cname)
    crow.append([q(crew_id[cname]), q(cname), q(dept), q(color), q(i)])
    mrow.append([q(crew_id[cname]), q(emp_id[lead]), q("lead")])
    mrow += [[q(crew_id[cname]), q(emp_id[h]), q("helper")] for h in helpers]
p3 = [
    inserts("employees", ["id", "first_name", "last_name", "default_position", "departments", "home_facility"], erows),
    inserts("employee_aliases", ["employee_id", "alias", "source"], arows),
    inserts("crews", ["id", "name", "department", "color", "sort_order"], crow),
    inserts("crew_default_members", ["crew_id", "employee_id", "position"], mrow),
]
sizes["03_employees_crews.sql"] = write("03_employees_crews.sql", p3, "3 of 5 · Employees (with name spellings) and usual crews")

# ---------------------------------------------------------------------------
# 04 prevailing wage list: match each line to an existing job, or create it
# ---------------------------------------------------------------------------
company_by_key = {k: c for k, c in companies.items()}
company_name = {c["id"]: c["name"] for c in companies.values()}
jobs_by_company = collections.defaultdict(list)
for (cid, k), j in jobs.items():
    jobs_by_company[cid].append((k, j))

STATE = re.compile(r"^(CA|NV|AZ|OR|ID)\b", re.I)


def parse_pw(text):
    t = re.sub(r"\s+", " ", text).strip()
    note = "; ".join(re.findall(r"\(([^)]*)\)", t))
    t = re.sub(r"\([^)]*\)", "", t).strip(" ,")
    parts = [p.strip() for p in t.split(",") if p.strip()]
    name = parts[0] if parts else t
    if " - KT SALES" in name.upper():
        name, note = re.split(r"\s+-\s+KT SALES", name, flags=re.I)[0], (note + "; KT Sales").strip("; ")
    # 'KIMBALL HIGHLAND WEST 1221 D St. National City' — address run into the name (needs a street word)
    m0 = re.match(r"^(.*?[A-Za-z])\s+(\d{2,}\s+\w+\s+(?:St|Ave|Blvd|Rd|Dr|Way)\b.*)$", name, re.I)
    if m0:
        name, parts = m0.group(1), [m0.group(1), m0.group(2)] + parts[1:]
    rest = parts[1:]
    # 'Los Angeles CA 90015' (no comma before the state)
    for i, p_ in enumerate(rest):
        m1 = re.match(r"^(.*?)\s+(CA|NV)(\s+\d{5})?$", p_)
        if m1 and m1.group(1) and not re.search(r"\d", m1.group(1)):
            rest = rest[:i] + [m1.group(1), "CA" + (m1.group(3) or "")] + rest[i + 1:]
            break
        if m1 and re.search(r"\d", m1.group(1)):   # '1221 D St. National City CA' -> street + city
            m2 = re.match(r"^(\d+.*?(?:St|Ave|Blvd|Rd|Dr|Way)\.?)\s+(.*)$", m1.group(1))
            if m2:
                rest = rest[:i] + [m2.group(1), m2.group(2), "CA" + (m1.group(3) or "")] + rest[i + 1:]
                break
    city = None
    for i, p in enumerate(rest):
        if STATE.match(p):
            city = rest[i - 1] if i > 0 else None
            m3 = re.match(r"^\d+.*?\b(?:St|Ave|Blvd|Rd|Dr|Way)\.?\s+(.+)$", city or "", re.I)
            if m3:   # '1221 D St. National City'
                city = m3.group(1)
            break
    else:
        if rest:
            city = rest[-1] if not re.search(r"\d", rest[-1]) else None
    if city and re.search(r"\d", city):
        city = None
    m = re.match(r"^(.*?)\s+CA\s*\d*$", city or "")
    if m:
        city = m.group(1)
    address = ", ".join(rest) if rest else None
    if city and city.strip().upper() == "LA":
        city = "Los Angeles"
    if not city and not rest and re.fullmatch(r"[A-Z ]+", t.split(",")[-1].strip()) and "," in t:
        city = t.split(",")[-1].strip()
    return name.strip(), address, (city.strip().title() if city and city.isupper() else (city.strip() if city else None)), note


def ratio(a, b):
    return difflib.SequenceMatcher(None, a, b).ratio()


wbp = openpyxl.load_workbook(pw_path, data_only=True)
pw_rows = [r for r in wbp.worksheets[0].iter_rows(min_row=2, values_only=True) if r and r[0] and r[1]]
PW_FROM = "2025-01-01"
# PW-list customer -> how the same company is spelled in the shipping data
PW_COMPANY_SAME_AS = {"2020 plumbing": "20/20 Plumbing & Heating Inc.", "icg intergration construction": "ICG Incorporated",
                      "lovazzano": "Lovazzano Mechanical, Inc."}
# PW-list job -> the shipping job it is (different wording on each list). Review these in pw_import_review.csv.
PW_JOB_SAME_AS = {
    "the 101 apartments": "101 Apartments", "prisma artist s lofts": "Prisma Lofts", "monarch at redwood": "MONARCH APTS.",
    "cambern ave apts": "3rd and Cambern Avenue Apartments", "north city block f phase a": "North City **PREV. WAGE/TURNKEY**",
    "jfm senior villas apts": "JFM VILLAS SR. APTS.", "fort irwin apts": "Tiefort View **PRE. WAGE/TURNKEY** Fort Irwin, CA",
    "fountain street apts": "FOUNTAIN VALLEY APARTMENTS",   # crew sheets + shipping say Fountain Valley; PW list says Fountain Street
}
job_by_key = {}
for (c, k), j in jobs.items():
    job_by_key.setdefault(k, j)
new_companies, new_jobs, parties, periods, updates, review_pw, new_job_aliases, new_company_aliases = {}, {}, [], [], [], [], [], []
for cust_raw, job_raw in pw_rows:
    cust_raw, job_raw = str(cust_raw).strip(), str(job_raw).strip()
    name, address, city, note = parse_pw(job_raw)
    if "NOT A PREVAILING WAGE" in job_raw.upper():
        review_pw.append([cust_raw, job_raw, "skipped", "", "list says NOT a prevailing wage job"])
        continue
    ck = company_key(cust_raw)
    comp = company_by_key.get(ck)
    if not comp and ck in PW_COMPANY_SAME_AS:
        cid0 = alias_to_company[PW_COMPANY_SAME_AS[ck]]
        comp = next(c for c in companies.values() if c["id"] == cid0)
        new_company_aliases.append([q(cid0), q(cust_raw), q("pw_list")])
    if not comp:  # fuzzy company match (e.g. 'Imperial T & S Plumbing')
        best = max(company_by_key, key=lambda k: ratio(k, ck))
        if ratio(best, ck) >= 0.88:
            comp = company_by_key[best]
    if comp:
        cust_id = comp["id"]
    else:
        cust_id = uid("company", "pw", ck)
        new_companies[cust_id] = cust_raw.strip()
    jk = job_key(name)
    match, how = None, ""
    if jk in PW_JOB_SAME_AS:
        match, how = job_by_key[job_key(PW_JOB_SAME_AS[jk])], "named match (check)"
        if match["customer_id"] != cust_id:
            parties.append([q(match["id"]), q(cust_id), q("contractor"), q("From PW list")])
    cands = jobs_by_company.get(cust_id, [])
    if cands and not match:
        k, j = max(cands, key=lambda kj: ratio(kj[0], jk))
        if ratio(k, jk) >= 0.82 or (len(jk) > 6 and (jk in k or k in jk)):
            match, how = j, f"same customer · {ratio(k, jk):.0%}"
    if not match:  # same job billed through another company (e.g. supply house)
        k_best, j_best = max(((k, j) for (c, k), j in jobs.items()), key=lambda kj: ratio(kj[0], jk))
        if ratio(k_best, jk) >= 0.93 and len(jk) > 8:
            match, how = j_best, f"other customer ({company_name[j_best['customer_id']]}) · {ratio(k_best, jk):.0%}"
            parties.append([q(j_best["id"]), q(cust_id), q("contractor"), q("From PW list")])
    if match:
        jid = match["id"]
        updates.append(f"update public.jobs set address = coalesce(address, {q(address)}), city = coalesce(city, {q(city)}) where id = {q(jid)};")
        if norm(name) != norm(match["name"]):
            new_job_aliases.append([q(jid), q(name), q("pw_list")])
        review_pw.append([cust_raw, job_raw, "matched", match["name"], how])
    else:
        jid = uid("job", "pw", cust_id, jk)
        new_jobs[jid] = (name, cust_id, address, city, note)
        review_pw.append([cust_raw, job_raw, "created", name, city or ""])
    periods.append([q(uid("pw", jid)), q(jid), q(PW_FROM), q("From PW list received 11/2/2026" + (f" · {note}" if note else ""))])

p4 = [
    inserts("companies", ["id", "name", "kinds"], [[q(i), q(n), qa(["contractor"])] for i, n in new_companies.items()]),
    inserts("company_aliases", ["company_id", "alias", "source"], [[q(i), q(n), q("pw_list")] for i, n in new_companies.items()] + new_company_aliases),
    inserts("jobs", ["id", "name", "customer_id", "address", "city", "description"],
            [[q(i), q(n), q(c), q(a), q(ci), q(nt or None)] for i, (n, c, a, ci, nt) in new_jobs.items()]),
    inserts("job_aliases", ["job_id", "alias", "source"], new_job_aliases),
    "\n".join(updates),
    inserts("job_parties", ["job_id", "company_id", "role", "note"], parties),
    inserts("prevailing_wage_periods", ["id", "job_id", "effective_from", "source_note"], periods),
]
sizes["04_prevailing_wage.sql"] = write("04_prevailing_wage.sql", p4, "4 of 5 · Prevailing wage jobs (matched to existing jobs or created) and PW flags")
with open(os.path.join(out_dir, "pw_import_review.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["customer_on_pw_list", "job_on_pw_list", "result", "job_in_app", "detail"])
    w.writerows(review_pw)

# ---------------------------------------------------------------------------
# 05 TEST DAY from the 10/29 - 10/30 paperwork
# ---------------------------------------------------------------------------
T = json.load(open(trans_path))
fs = []


def find_job(cust_kw, job_kw):
    best = None
    for (cid, k), j in jobs.items():
        cname = company_name[cid]
        if cust_kw in norm(cname) and re.search(r"\b" + re.escape(job_kw) + r"\b", k):
            if best is None or len(k) < len(best[1]):
                best = (j, k)
    return best[0] if best else None


FIELD_JOBS = {
    "delamo": ("century west", "del amo"), "woodman": ("alpa", "woodman"), "sepulveda": ("century west", "6728"),
    "discovery": ("western national", "discovery park"), "oro": ("lennar", "oro mesa"), "6thpalm": ("sherwood", "palm"),
    "harvest": ("lennar", "harvest"), "deanza": ("monte vista", "anza"), "skyline": ("lennar", "skyline"),
    "outbound": ("lennar", "outbound"), "bellamy": ("production plus", "bellamy"), "fountain": ("mg plumbing", "fountain valley"),
    "slauson": ("hydroflow", "slauson"), "ashbury": ("new home", "ashbury"),
}
CITIES = {"delamo": "Torrance", "woodman": "Van Nuys", "sepulveda": "Van Nuys", "discovery": "Irvine", "oro": "San Diego",
          "6thpalm": "San Diego", "harvest": "Jurupa Valley", "deanza": "Riverside", "skyline": "Jurupa Valley",
          "outbound": "Rialto", "bellamy": "Agoura Hills", "fountain": "Long Beach", "slauson": "Los Angeles", "ashbury": "Eastvale"}
field_job = {}
for key, (ckw, jkw) in FIELD_JOBS.items():
    j = find_job(ckw, jkw)
    assert j, f"test-day job not found in shipping data: {key}"
    field_job[key] = j["id"]
    fs.append(f"update public.jobs set city = coalesce(city, {q(CITIES[key])}) where id = {q(j['id'])};")

shea = find_job("slakey", "shea portola")
if shea:
    pierce = next((c["id"] for k, c in companies.items() if k.startswith("jr pierce")), None) or uid("company", "pw", "jr pierce")
    fs.append(inserts("companies", ["id", "name", "kinds"], [[q(pierce), q("JR Pierce"), qa(["contractor"])]]))
    fs.append(inserts("job_parties", ["job_id", "company_id", "role"], [[q(shea["id"]), q(pierce), q("contractor")]]))
    fs.append(f"update public.jobs set city = coalesce(city, 'Livermore') where id = {q(shea['id'])};")

FORM_MAP = {
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
CREW_OF = {c[0]: c for c in CREWS}
alias_index = {}
for e in EMP:
    for a in [e["full"]] + e["alias"] + HANDWRITING.get(e["full"], []):
        alias_index.setdefault(norm(a), set()).add(e["full"])


def who(raw, cname):
    n = norm(raw)
    hits = alias_index.get(n, set())
    crew = CREW_OF[cname]
    members = {crew[2], *crew[3]}
    if len(hits) != 1:  # e.g. 'Jose' — resolve within the crew that day
        hits = {m for m in members if norm(m).split()[0] == n}
    return emp_id[next(iter(hits))] if len(hits) == 1 else None


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
    return "stockpiled" if "pile" in s else "room_in" if "room" in s else "returned" if "return" in s else "done"


cd_rows, cdm_rows, stop_rows, wo_rows, wl_rows, flag_rows, worker_rows, note_rows = [], [], [], [], [], [], [], []
crew_days = {}
for (cname, dept, lead, helpers, _) in CREWS:
    date = "2026-10-29" if dept == "socal-install" else "2026-10-30"
    cdid = uid("crewday", cname, date)
    crew_days[cname] = (cdid, date)
    cd_rows.append([q(cdid), q(crew_id[cname]), q(date)])
    cdm_rows.append([q(cdid), q(date), q(emp_id[lead]), q("lead"), q("present")])
    cdm_rows += [[q(cdid), q(date), q(emp_id[h]), q("helper"), q("present")] for h in helpers]

for r in T:
    key = (r.get("file"), r.get("page"))
    if key not in FORM_MAP:
        continue
    jkey, cname, seq, typ = FORM_MAP[key]
    cdid, date = crew_days[cname]
    number = f"{typ}-26-{9000 + len(wo_rows) + 1:04d}"           # test range 9000+
    woid = uid("wo", *key)
    flags = [FLAG_MAP[f] for f in r.get("flags") or [] if f in FLAG_MAP]
    canceled = "canceled" in (r.get("flags") or []) or (r.get("lines") == [] and "not_ready" in flags)
    if "no_signature" in flags and r.get("superintendent_signed"):
        flags.remove("no_signature")
    wo_rows.append([q(woid), q(number), q(typ), q(field_job[jkey]), q("canceled" if canceled else "complete"),
                    q(r.get("notes_english") if canceled else None), q(date),
                    q(f"{'Install' if typ == 'IN' else 'Stock'} — {r.get('phase_or_building') or 'per order'}"),
                    q("order"), q(True), q(t24(r.get("time_in"))), q(t24(r.get("time_out"), True)),
                    q(r.get("notes_original")), q(r.get("notes_english")),
                    q(bool(r.get("superintendent_signed"))), qj({"test_day": True, "paper": f"{key[0]} p{key[1]}"})])
    stop_rows.append([q(uid("stop", *key)), q(cdid), q(woid), q(seq)])
    for i, l in enumerate(r.get("lines") or []):
        wl_rows.append([q(uid("woline", *key, i)), q(woid), q(str(l.get("lot") or "").replace("?", "")),
                        q(l.get("form_column")), q(l.get("product_or_sku")),
                        q(l.get("hand") if l.get("hand") in ("L", "R") else None),
                        q(l.get("qty") or 1), q(l.get("qty") or 1), q(line_status(l.get("status"))), q(i)])
    first_note = True
    for f in dict.fromkeys(flags):
        give = first_note and f not in ("no_signature", "photos_offline")
        flag_rows.append([q(uid("flag", *key, f)), q(woid), q(f), q(r.get("notes_english") if give else None)])
        first_note = first_note and not give
    for n, pos in [(r.get("lead"), "lead")] + [(h, "helper") for h in r.get("helpers") or []]:
        if not n:
            continue
        raw = n.replace("?", "").strip()
        match = who(raw, cname)
        worker_rows.append([q(uid("worker", *key, raw)), q(woid), q(match), q(n), q(pos), q("scan"), q(0.95 if match else None)])
    if r.get("notes_original"):
        note_rows.append([q(uid("note", *key)), q(woid), q("Crew note (from paper): " + r["notes_original"]), q("es"), q(r.get("notes_english"))])

fs += [
    inserts("crew_days", ["id", "crew_id", "work_date"], cd_rows),
    inserts("crew_day_members", ["crew_day_id", "work_date", "employee_id", "position", "status"], cdm_rows),
    inserts("work_orders", ["id", "number", "type_code", "job_id", "status", "status_reason", "scheduled_date", "scope", "source",
                            "crew_on_site", "time_in", "time_out", "completion_notes", "completion_notes_en", "superintendent_signed",
                            "legacy_ids"], wo_rows),
    inserts("crew_day_stops", ["id", "crew_day_id", "work_order_id", "sequence"], stop_rows),
    inserts("work_order_lines", ["id", "work_order_id", "lot_label", "room", "raw_product", "hand", "qty_planned", "qty_done",
                                 "status", "sort_order"], wl_rows),
    inserts("work_order_flags", ["id", "work_order_id", "flag_code", "note"], flag_rows),
    inserts("work_order_workers", ["id", "work_order_id", "employee_id", "raw_name", "position", "source", "match_confidence"], worker_rows),
    inserts("notes", ["id", "work_order_id", "body", "body_language", "body_translated"], note_rows),
    f"""insert into public.work_orders (id, number, type_code, job_id, status, scheduled_date, scope, parent_id, follow_up_suffix, source, legacy_ids)
values ({q(uid('wo', 'discovery-followup'))}, 'IN-26-9004-B', 'IN', {q(field_job['discovery'])}, 'planned', '2026-11-03',
        'Return — install once waterproofing is up (Edgar said Tuesday)', {q(uid('wo', 'install', 6))}, 'B', 'follow_up', '{{"test_day": true}}')
on conflict do nothing;""",
]
sizes["05_test_day_oct29_30.sql"] = write("05_test_day_oct29_30.sql", fs, "5 of 5 · TEST DATA: the 10/29-10/30 paperwork as work orders (work order numbers 9001+)")

cleanup = """-- Removes ONLY the 10/29-10/30 test-day work orders, their rosters and notes. Everything else stays.
begin;
delete from public.notes where work_order_id in (select id from public.work_orders where legacy_ids ? 'test_day');
delete from public.work_orders where legacy_ids ? 'test_day' and parent_id is not null;
delete from public.work_orders where legacy_ids ? 'test_day';
delete from public.crew_days where work_date in ('2026-10-29', '2026-10-30')
  and not exists (select 1 from public.crew_day_stops s where s.crew_day_id = crew_days.id);
commit;
"""
open(os.path.join(out_dir, "99_remove_test_day.sql"), "w").write(cleanup)

unmatched = sum(1 for r in worker_rows if r[2] == "null")
print(f"companies {len(companies)}+{len(new_companies)} | jobs {len(jobs)}+{len(new_jobs)} | products {len(products)} | "
      f"shipments {n_ships} / lines {n_lines} in {len(part_files)} parts | employees {len(EMP)} | crews {len(CREWS)} | "
      f"PW {len(periods)} (matched {sum(1 for r in review_pw if r[2]=='matched')}, created {len(new_jobs)}, skipped {sum(1 for r in review_pw if r[2]=='skipped')}) | "
      f"test WOs {len(wo_rows)} (unmatched names {unmatched})")
for k, v in sizes.items():
    print(f"  {k:36s} {v/1024:7.0f} KB")
