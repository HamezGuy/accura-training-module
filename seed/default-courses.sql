-- ============================================================================
-- AccuraTrial Training Module — SOP-Based Course Seed Data
-- 15 Feature Training Courses + 3 Regulatory Courses
-- Idempotent: uses ON CONFLICT DO NOTHING
-- ============================================================================

-- ============================================================================
-- COURSES (15 SOP-based + 3 regulatory = 18 total)
-- ============================================================================

INSERT INTO acc_training_courses (course_code, course_name, description, version, duration_minutes, passing_score, required_for_roles, regulatory_reference, validity_period_days)
VALUES
('LOGIN-NAV', 'Login and Navigation', 'Learn how to sign into AccuraTrial EDC, navigate the dashboard, use the sidebar, and manage your profile. Based on SOP-032.', '5.0', 20, 80, '["admin","manager","investigator","coordinator","monitor","viewer"]'::jsonb, '21 CFR Part 11 §11.10(i)', NULL),
('USER-MGMT', 'User Management', 'Learn how to create users, assign roles, manage permissions, and handle access control. Based on SOP-015.', '6.0', 25, 80, '["admin","manager"]'::jsonb, '21 CFR Part 11 §11.10(d)', 365),
('STUDY-MGMT', 'Study Management', 'Learn how to create and configure clinical studies, define visits, manage sites, and control study parameters. Based on SOP-025.', '7.0', 35, 80, '["admin","manager","coordinator"]'::jsonb, 'ICH E6(R2) GCP', 365),
('FORM-CREATE', 'Form Creation and Management', 'Learn how to design CRF forms using the 5-tab builder, configure 78 field types, set up workflows, and publish forms. Based on SOP-016.', '7.0', 45, 75, '["admin","manager"]'::jsonb, '21 CFR Part 11', 365),
('DATA-ENTRY', 'Clinical Data Entry', 'Learn how to enter clinical data, navigate patient forms, handle validation errors, submit with e-signatures, and make corrections. Based on SOP-029.', '6.0', 30, 80, '["investigator","coordinator"]'::jsonb, '21 CFR Part 11 §11.10(e)', 365),
('PATIENT-MGMT', 'Patient/Subject Management', 'Learn how to enroll patients, generate subject IDs, manage visits, and track patient progress through the study. Based on SOP-026.', '6.0', 25, 80, '["admin","manager","investigator","coordinator","monitor"]'::jsonb, 'ICH E6(R2) GCP', 365),
('VAL-RULES', 'Validation Rules and Branching Logic', 'Learn how to create validation rules using Quick Add, AI Suggester, and the Rule Builder. Configure branching logic for conditional field display. Based on SOP-019.', '8.0', 40, 75, '["admin","manager"]'::jsonb, '21 CFR Part 11 §11.10(h)', 365),
('QUERY-MGMT', 'Query Management', 'Learn how to create, respond to, and resolve data queries. Understand automatic query generation from validation rules and bulk operations. Based on SOP-020.', '6.0', 25, 80, '["admin","manager","investigator","coordinator","monitor"]'::jsonb, 'ICH E6(R2) GCP', 365),
('DATA-LOCKS', 'Data Lock Management', 'Learn how to freeze and lock CRF data, manage unlock requests, perform casebook readiness checks, and execute study-level locks. Based on SOP-018.', '6.0', 25, 80, '["admin","manager","monitor"]'::jsonb, '21 CFR Part 11', 365),
('E-SIGN', 'Electronic Signatures', 'Learn how to apply electronic signatures per 21 CFR Part 11, understand the two-component authentication process, and manage signature manifestations. Based on SOP-021.', '5.0', 15, 85, '["admin","manager","investigator","coordinator","monitor","viewer"]'::jsonb, '21 CFR Part 11 §11.50', 365),
('SDV', 'Source Data Verification', 'Learn how to perform source data verification, use the SDV dashboard, mark fields as verified, and track verification progress. Based on SOP-028.', '5.0', 25, 80, '["monitor"]'::jsonb, 'ICH E6(R2) §6.4.9', 365),
('WORKFLOW', 'Workflow Management and Tasks', 'Learn how to configure per-form workflows, manage task assignments, use My Tasks, and set up SDV/DDE/signature requirements. Based on SOP-017.', '6.0', 30, 80, '["admin","manager"]'::jsonb, '21 CFR Part 11', 365),
('DATA-EXPORT', 'Data Export', 'Learn how to export clinical data in multiple formats (PDF, Excel, CSV, ODM XML), configure export options, and generate regulatory-ready packages. Based on SOP-022.', '5.0', 20, 80, '["admin","manager","monitor","viewer"]'::jsonb, 'ICH E6(R2)', 365),
('REPORTS', 'Reports and Analytics', 'Learn how to use the reports dashboard, generate enrollment reports, view data quality metrics, and create custom analytics. Based on SOP-031.', '5.0', 20, 80, '["admin","manager","investigator","coordinator","monitor","viewer"]'::jsonb, 'ICH E6(R2)', 365),
('RANDOMIZE', 'Randomization', 'Learn how to configure randomization algorithms, manage sealed lists, perform patient randomization, handle stratification, and use emergency unblinding. Based on SOP-030.', '5.0', 25, 80, '["admin","investigator"]'::jsonb, 'ICH E6(R2) GCP', 365),
('GCP-101', 'Good Clinical Practice (GCP) Fundamentals', 'Comprehensive training on ICH E6(R2) Good Clinical Practice guidelines covering investigator responsibilities, informed consent, IRB/IEC requirements, essential documents, and data integrity.', '2.0', 120, 80, '["admin","manager","investigator","coordinator","monitor"]'::jsonb, 'ICH E6(R2) GCP', 365),
('CFR11-101', '21 CFR Part 11: Electronic Records and Signatures', 'Training on FDA 21 CFR Part 11 requirements for electronic records and electronic signatures, including system controls, audit trails, access management, and signature manifestations.', '1.5', 90, 85, '["admin","manager","investigator","coordinator","monitor","viewer"]'::jsonb, '21 CFR Part 11', 365),
('HIPAA-101', 'HIPAA Privacy and Security for Clinical Research', 'Training on HIPAA Privacy Rule and Security Rule as applicable to clinical research. Covers PHI handling, minimum necessary standard, breach notification, and technical safeguards.', '1.3', 60, 80, '["admin","manager","investigator","coordinator","monitor"]'::jsonb, 'HIPAA §164.308(a)(5)', 365)
ON CONFLICT (course_code) DO NOTHING;
