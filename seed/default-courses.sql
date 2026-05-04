-- ============================================================================
-- AccuraTrial Training Module — Default Course Seed Data
-- 
-- Run after migrations to populate required training courses.
-- Idempotent: uses ON CONFLICT DO NOTHING.
-- ============================================================================

-- GCP Fundamentals (required for all clinical roles)
INSERT INTO acc_training_courses (course_code, course_name, description, version, duration_minutes, passing_score, required_for_roles, regulatory_reference, validity_period_days)
VALUES (
  'GCP-101',
  'Good Clinical Practice (GCP) Fundamentals',
  'Comprehensive training on ICH E6(R2) Good Clinical Practice guidelines covering investigator responsibilities, informed consent, IRB/IEC requirements, essential documents, and data integrity in clinical trials.',
  '2.0',
  120,
  80,
  '["admin", "manager", "investigator", "coordinator", "monitor"]'::jsonb,
  'ICH E6(R2) GCP',
  365
)
ON CONFLICT (course_code) DO NOTHING;

-- 21 CFR Part 11 (required for all system users)
INSERT INTO acc_training_courses (course_code, course_name, description, version, duration_minutes, passing_score, required_for_roles, regulatory_reference, validity_period_days)
VALUES (
  'CFR11-101',
  '21 CFR Part 11: Electronic Records & Signatures',
  'Training on FDA 21 CFR Part 11 requirements for electronic records and electronic signatures, including system controls, audit trails, access management, and signature manifestations.',
  '1.5',
  90,
  85,
  '["admin", "manager", "investigator", "coordinator", "monitor", "viewer"]'::jsonb,
  '21 CFR Part 11',
  365
)
ON CONFLICT (course_code) DO NOTHING;

-- HIPAA Privacy & Security (required for all with patient data access)
INSERT INTO acc_training_courses (course_code, course_name, description, version, duration_minutes, passing_score, required_for_roles, regulatory_reference, validity_period_days)
VALUES (
  'HIPAA-101',
  'HIPAA Privacy & Security for Clinical Research',
  'Training on HIPAA Privacy Rule and Security Rule as applicable to clinical research. Covers PHI handling, minimum necessary standard, breach notification, and technical safeguards.',
  '1.3',
  60,
  80,
  '["admin", "manager", "investigator", "coordinator", "monitor"]'::jsonb,
  'HIPAA §164.308(a)(5)',
  365
)
ON CONFLICT (course_code) DO NOTHING;

-- System User Training (version-tied to EDC version)
INSERT INTO acc_training_courses (course_code, course_name, description, version, duration_minutes, passing_score, required_for_roles, regulatory_reference, validity_period_days)
VALUES (
  'SYS-EDC-v1',
  'AccuraTrial EDC System Training',
  'Hands-on training for the AccuraTrial Electronic Data Capture system. Covers data entry, query management, e-signatures, SDV workflow, and reporting features. Version-specific to ensure users are trained on the current system.',
  '1.0',
  180,
  75,
  '["admin", "manager", "investigator", "coordinator", "monitor", "viewer"]'::jsonb,
  '21 CFR Part 11 §11.10(i)',
  NULL
)
ON CONFLICT (course_code) DO NOTHING;

-- Data Integrity Training
INSERT INTO acc_training_courses (course_code, course_name, description, version, duration_minutes, passing_score, required_for_roles, regulatory_reference, validity_period_days)
VALUES (
  'DI-101',
  'Data Integrity in Clinical Trials (ALCOA+)',
  'Training on ALCOA+ principles (Attributable, Legible, Contemporaneous, Original, Accurate, Complete, Consistent, Enduring, Available). Covers source data verification, correction procedures, and audit trail interpretation.',
  '1.0',
  45,
  80,
  '["coordinator", "monitor", "investigator"]'::jsonb,
  'FDA Data Integrity Guidance 2018',
  365
)
ON CONFLICT (course_code) DO NOTHING;

-- ============================================================================
-- Quiz Questions for GCP-101
-- ============================================================================

INSERT INTO acc_training_questions (course_id, question_text, question_type, options, explanation, order_index)
SELECT c.id, q.question_text, q.question_type, q.options, q.explanation, q.order_index
FROM acc_training_courses c
CROSS JOIN (VALUES
  ('What is the primary purpose of Good Clinical Practice (GCP)?', 'multiple_choice',
   '[{"text": "To protect the rights, safety, and well-being of trial subjects", "isCorrect": true}, {"text": "To speed up drug approval", "isCorrect": false}, {"text": "To reduce clinical trial costs", "isCorrect": false}, {"text": "To simplify regulatory submissions", "isCorrect": false}]'::jsonb,
   'ICH E6(R2) Section 1 states that GCP is an international ethical and scientific quality standard for designing, conducting, recording, and reporting trials that involve the participation of human subjects.',
   1),
  ('Under GCP, who is ultimately responsible for the medical care of trial subjects?', 'multiple_choice',
   '[{"text": "The sponsor", "isCorrect": false}, {"text": "The CRO", "isCorrect": false}, {"text": "The principal investigator", "isCorrect": true}, {"text": "The IRB/IEC", "isCorrect": false}]'::jsonb,
   'Per ICH E6(R2) Section 4.3, the investigator should ensure that adequate medical care is provided to a subject for any adverse events.',
   2),
  ('Informed consent must be obtained before any study-related procedure.', 'true_false',
   '[{"text": "True", "isCorrect": true}, {"text": "False", "isCorrect": false}]'::jsonb,
   'ICH E6(R2) Section 4.8.8 requires that the informed consent form be signed and dated before any study-related procedure.',
   3),
  ('Which documents are considered essential documents in a clinical trial? (Select all that apply)', 'multi_select',
   '[{"text": "Investigator''s Brochure", "isCorrect": true}, {"text": "Signed informed consent forms", "isCorrect": true}, {"text": "Investigator''s personal notes", "isCorrect": false}, {"text": "IRB/IEC approval letter", "isCorrect": true}, {"text": "Subject screening log", "isCorrect": true}]'::jsonb,
   'Essential documents are those documents which individually and collectively permit evaluation of the conduct of a trial and the quality of the data produced (ICH E6(R2) Section 8).',
   4),
  ('How long must clinical trial records be retained according to ICH GCP?', 'multiple_choice',
   '[{"text": "1 year after study completion", "isCorrect": false}, {"text": "2 years after the last approval of a marketing application", "isCorrect": true}, {"text": "5 years after database lock", "isCorrect": false}, {"text": "10 years regardless of approval status", "isCorrect": false}]'::jsonb,
   'Per ICH E6(R2) Section 4.9.5, records should be retained until at least 2 years after the last approval of a marketing application or 2 years after formal discontinuation of clinical development.',
   5)
) AS q(question_text, question_type, options, explanation, order_index)
WHERE c.course_code = 'GCP-101'
AND NOT EXISTS (SELECT 1 FROM acc_training_questions WHERE course_id = c.id);

-- ============================================================================
-- Quiz Questions for CFR11-101
-- ============================================================================

INSERT INTO acc_training_questions (course_id, question_text, question_type, options, explanation, order_index)
SELECT c.id, q.question_text, q.question_type, q.options, q.explanation, q.order_index
FROM acc_training_courses c
CROSS JOIN (VALUES
  ('What does 21 CFR Part 11 primarily regulate?', 'multiple_choice',
   '[{"text": "Paper record retention", "isCorrect": false}, {"text": "Electronic records and electronic signatures", "isCorrect": true}, {"text": "Clinical trial design", "isCorrect": false}, {"text": "Drug manufacturing processes", "isCorrect": false}]'::jsonb,
   '21 CFR Part 11 establishes the criteria under which the FDA considers electronic records and electronic signatures to be trustworthy, reliable, and equivalent to paper records.',
   1),
  ('An electronic signature under Part 11 must include which components?', 'multi_select',
   '[{"text": "Username", "isCorrect": true}, {"text": "Password", "isCorrect": true}, {"text": "Fingerprint scan", "isCorrect": false}, {"text": "Meaning of the signature (reason)", "isCorrect": true}, {"text": "Date and time", "isCorrect": true}]'::jsonb,
   'Per §11.50, electronic signatures must include the printed name of the signer, date and time, and meaning (such as review, approval, responsibility, or authorship).',
   2),
  ('Audit trails required by Part 11 must be computer-generated and time-stamped.', 'true_false',
   '[{"text": "True", "isCorrect": true}, {"text": "False", "isCorrect": false}]'::jsonb,
   'Per §11.10(e), procedures and controls must include the use of secure, computer-generated, time-stamped audit trails to independently record the date and time of operator entries.',
   3),
  ('Under Part 11, who is responsible for ensuring system access controls are adequate?', 'multiple_choice',
   '[{"text": "The FDA", "isCorrect": false}, {"text": "The system vendor only", "isCorrect": false}, {"text": "The organization using the system", "isCorrect": true}, {"text": "Individual users", "isCorrect": false}]'::jsonb,
   'Per §11.10, persons who use closed systems to create, modify, maintain, or transmit electronic records shall employ procedures and controls designed to ensure system security.',
   4),
  ('Which of the following is required for system validation under Part 11?', 'multiple_choice',
   '[{"text": "Validation only at initial installation", "isCorrect": false}, {"text": "Validation ensuring accuracy, reliability, and intended performance throughout the system lifecycle", "isCorrect": true}, {"text": "Validation by the FDA before use", "isCorrect": false}, {"text": "Annual revalidation only", "isCorrect": false}]'::jsonb,
   'Per §11.10(a), validation of systems to ensure accuracy, reliability, consistent intended performance, and the ability to discern invalid or altered records.',
   5)
) AS q(question_text, question_type, options, explanation, order_index)
WHERE c.course_code = 'CFR11-101'
AND NOT EXISTS (SELECT 1 FROM acc_training_questions WHERE course_id = c.id);

-- ============================================================================
-- Quiz Questions for HIPAA-101
-- ============================================================================

INSERT INTO acc_training_questions (course_id, question_text, question_type, options, explanation, order_index)
SELECT c.id, q.question_text, q.question_type, q.options, q.explanation, q.order_index
FROM acc_training_courses c
CROSS JOIN (VALUES
  ('What does PHI stand for?', 'multiple_choice',
   '[{"text": "Personal Health Insurance", "isCorrect": false}, {"text": "Protected Health Information", "isCorrect": true}, {"text": "Private Hospital Information", "isCorrect": false}, {"text": "Patient History Index", "isCorrect": false}]'::jsonb,
   'Protected Health Information (PHI) is individually identifiable health information held or transmitted by a covered entity or its business associate.',
   1),
  ('The minimum necessary standard means:', 'multiple_choice',
   '[{"text": "Using the minimum amount of PHI needed to accomplish the intended purpose", "isCorrect": true}, {"text": "Keeping the minimum number of patient records", "isCorrect": false}, {"text": "Using the minimum security measures required by law", "isCorrect": false}, {"text": "Retaining records for the minimum required period", "isCorrect": false}]'::jsonb,
   'The minimum necessary standard requires covered entities to make reasonable efforts to limit PHI to the minimum necessary to accomplish the intended purpose of the use, disclosure, or request.',
   2),
  ('A HIPAA breach must be reported to affected individuals within what timeframe?', 'multiple_choice',
   '[{"text": "24 hours", "isCorrect": false}, {"text": "30 days", "isCorrect": false}, {"text": "60 days of discovery", "isCorrect": true}, {"text": "90 days", "isCorrect": false}]'::jsonb,
   'Per the Breach Notification Rule, covered entities must notify affected individuals without unreasonable delay and no later than 60 days from discovery of the breach.',
   3),
  ('Research use of PHI always requires patient authorization under HIPAA.', 'true_false',
   '[{"text": "True", "isCorrect": false}, {"text": "False", "isCorrect": true}]'::jsonb,
   'There are exceptions: a waiver of authorization may be granted by an IRB or Privacy Board if the research meets specific criteria under §164.512(i).',
   4),
  ('Which of the following are examples of PHI identifiers? (Select all that apply)', 'multi_select',
   '[{"text": "Patient name", "isCorrect": true}, {"text": "Medical record number", "isCorrect": true}, {"text": "Disease category (e.g., diabetes)", "isCorrect": false}, {"text": "Social Security Number", "isCorrect": true}, {"text": "Date of birth", "isCorrect": true}]'::jsonb,
   'HIPAA defines 18 identifiers that make health information individually identifiable, including names, dates, SSN, MRN, and geographic data smaller than a state.',
   5)
) AS q(question_text, question_type, options, explanation, order_index)
WHERE c.course_code = 'HIPAA-101'
AND NOT EXISTS (SELECT 1 FROM acc_training_questions WHERE course_id = c.id);
