export type AppRole =
  | 'admin' | 'manager' | 'read_only_manager' | 'dispatcher'
  | 'shipping_coordinator' | 'driver' | 'lead_tech' | 'tech';

export type WoStatus = 'planned' | 'started' | 'on_hold' | 'complete' | 'canceled';
export type WoType = 'IN' | 'ST' | 'FN';
export type CrewPosition = 'lead' | 'helper' | 'driver' | 'other';
export type RosterStatus = 'scheduled' | 'present' | 'called_out' | 'no_show' | 'left_early';

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: AppRole;
  facility_access: string[];
  employee_id: string | null;
  active: boolean;
}

export interface BoardMember {
  employee_id: string;
  name: string;
  position: CrewPosition;
  status: RosterStatus;
  note: string | null;
}

export interface BoardStop {
  stop_id: string;
  sequence: number;
  planned_time: string | null;
  work_order_id: string;
  number: string;
  type: WoType;
  status: WoStatus;
  scope: string | null;
  job_id: string;
  job: string;
  city: string | null;
  customer: string;
  prevailing_wage: boolean;
  open_flags: number;
}

export interface BoardCrewDay {
  crew_day_id: string;
  work_date: string;
  crew_id: string | null;
  crew_name: string;
  department: string | null;
  color: string | null;
  members: BoardMember[];
  has_callout: boolean;
  stops: BoardStop[];
}

export interface TrayItem {
  id: string;
  number: string;
  type_code: WoType;
  status: WoStatus;
  scheduled_date: string | null;
  scope: string | null;
  priority: number;
  job_id: string;
  job: string;
  city: string | null;
  customer: string;
  prevailing_wage: boolean;
}

export interface Employee {
  id: string;
  first_name: string;
  last_name: string | null;
  display_name: string;
  employee_code: string | null;
  default_position: CrewPosition;
  departments: string[];
  employer: 'kt' | 'fcb';
  active: boolean;
}

export interface Department {
  code: string;
  region: string;
  name: string;
  work_type: WoType | null;
  sort_order: number;
  active: boolean;
}

export interface Crew {
  id: string;
  name: string;
  department: string | null;
  color: string | null;
  active: boolean;
  sort_order: number;
}

export interface FlagType {
  code: string;
  label: string;
  label_es: string | null;
  color: string;
  severity: number;
  offers_action: string | null;
}

export interface JobSummary {
  job_id: string;
  name: string;
  status: string;
  city: string | null;
  customer: string;
  prevailing_wage: boolean;
  work_orders: number;
  open_work_orders: number;
  open_flags: number;
  shipments: number;
  photos: number;
  videos: number;
  documents: number;
  notes: number;
  last_visit: string | null;
}

export interface FileRow {
  id: string;
  kind: 'photo' | 'video' | 'scan' | 'document' | 'plan' | 'signature' | 'report' | 'other';
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
  storage_path: string | null;
  thumbnail_path: string | null;
  created_at: string;
  uploaded_by: string | null;
  job_id: string | null;
  work_order_id: string | null;
  lot_id: string | null;
}

export interface NoteRow {
  id: string;
  body: string;
  body_translated: string | null;
  pinned: boolean;
  author_id: string | null;
  created_at: string;
  edited_at: string | null;
  job_id: string | null;
  company_id: string | null;
  area_id: string | null;
  lot_id: string | null;
  work_order_id: string | null;
  author?: { full_name: string | null; email: string | null } | null;
}
