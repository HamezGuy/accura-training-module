import { Slide } from './helpers';
import { loginNavSlides, userMgmtSlides, studyMgmtSlides } from './slides-part1';
import { formCreateSlides, patientMgmtSlides, valRulesSlides } from './slides-part2';
import { dataLocksSlides, eSignSlides, sdvSlides, workflowSlides } from './slides-part3';
import { dataExportSlides, reportsSlides, randomizeSlides } from './slides-part4';

export const courseSlides: Record<string, Slide[]> = {
  'LOGIN-NAV': loginNavSlides,
  'USER-MGMT': userMgmtSlides,
  'STUDY-MGMT': studyMgmtSlides,
  'FORM-CREATE': formCreateSlides,
  'DATA-ENTRY': loginNavSlides.length ? [] : [], // placeholder replaced below
  'PATIENT-MGMT': patientMgmtSlides,
  'VAL-RULES': valRulesSlides,
  'QUERY-MGMT': [], // will use SQL seed
  'DATA-LOCKS': dataLocksSlides,
  'E-SIGN': eSignSlides,
  'SDV': sdvSlides,
  'WORKFLOW': workflowSlides,
  'DATA-EXPORT': dataExportSlides,
  'REPORTS': reportsSlides,
  'RANDOMIZE': randomizeSlides,
};

// DATA-ENTRY slides inline (to avoid circular import)
import { buildSlide, h2, p, ul, ol, tip, warn, action, table } from './helpers';

courseSlides['DATA-ENTRY'] = [
  buildSlide(1, 'Welcome to Clinical Data Entry', h2('Clinical Data Entry Training'), p('Learn to enter clinical data accurately and compliantly.'), ul(['Navigate to patient forms','Enter data into various field types','Handle validation errors','Submit with e-signatures','Make corrections with audit trail']), tip('Based on SOP-029 v6.0')),
  buildSlide(2, 'Understanding CRF Forms', h2('Form Status Lifecycle'), p('Forms progress through these states:'), ol(['<strong>Not Started</strong> (gray) — no data entered','<strong>In Progress</strong> (blue) — data entry begun','<strong>Complete</strong> (green) — all required fields filled','<strong>Signed</strong> (purple) — e-signature applied','<strong>Frozen</strong> (light blue) — temporarily locked','<strong>Locked</strong> (red) — permanently sealed'])),
  buildSlide(3, 'Navigating to Forms', h2('The Data Entry Path'), ol(['Go to <strong>Patients</strong> page','Select a patient','Find the scheduled visit column','Click the form chip (colored indicator)','Form opens for data entry']), p('Chip colors indicate status. Click any chip to open.'), action('Navigate to a patient and open a form.')),
  buildSlide(4, 'The Data Entry Interface', h2('Form Layout'), p('The form modal has:'), ul(['<strong>Header</strong> — form name, version, status, patient ID','<strong>Body</strong> — fields in sections, single or multi-column','<strong>Footer</strong> — Save Draft, Submit & Sign, Close buttons']), p('Fields may appear/disappear based on skip logic.')),
  buildSlide(5, 'Field Types', h2('How to Enter Data'), table(['Type','How to Enter'],[['Text','Type directly'],['Number','Numbers only, decimal if configured'],['Date','Date picker or YYYY-MM-DD'],['Dropdown','Click and select one option'],['Radio','Click one option from group'],['Checkbox','Check one or more options'],['Textarea','Type longer text entries']]), p('Skip Logic may show/hide fields based on your answers.')),
  buildSlide(6, 'Validation Feedback', h2('Errors and Warnings'), p('<strong>Red (Blocks Save):</strong> Must fix before submitting.'), p('<strong>Yellow (Creates Query):</strong> Allows save but generates a query.'), p('Address red errors immediately. Yellow warnings need query response later.'), action('Enter an invalid value to see validation in action.')),
  buildSlide(7, 'Submitting and Signing', h2('Completing a Form'), ol(['Review all entries','Click "Submit & Sign"','Enter username + password + reason','Confirm — status changes to Signed']), warn('E-signatures are legally binding per 21 CFR Part 11.')),
  buildSlide(8, 'Making Corrections', h2('Reason for Change'), p('To correct signed data:'), ol(['Open the form','Click the field to change','Enter new value','System prompts for reason','Provide explanation and confirm']), p('Audit trail records: original value, new value, who, when, why. Original signature invalidated.')),
  buildSlide(9, 'Best Practices', h2('Data Entry Guidelines'), ul(['Have source documents ready before starting','Verify correct patient and visit','Save Draft frequently','Address validation errors immediately','Submit and sign promptly','Respond to auto-generated queries within 48 hours']), p('<strong>Ready for the quiz!</strong>'))
];

courseSlides['QUERY-MGMT'] = [
  buildSlide(1, 'Welcome to Query Management', h2('Query Management Training'), p('Learn to create, respond to, and resolve data queries.'), ul(['Understand query types and lifecycle','Use the Queries dashboard','Respond to assigned queries','Manage bulk operations']), tip('Based on SOP-020 v6.0')),
  buildSlide(2, 'Query Types', h2('Types of Queries'), table(['Type','When Used'],[['Query','Manual — raised by monitor or data manager'],['Failed Validation','Automatic — validation rule with Create Query severity'],['Annotation','Informational note — no response required'],['Reason for Change','Records why data was modified']])),
  buildSlide(3, 'The Queries Dashboard', h2('Your Query Hub'), p('Click Queries in the sidebar.'), ul(['Summary cards — total, assigned to you, overdue','Filter bar — status, severity, study, site, user','Query table — sortable with patient, form, field info','Bulk actions — select multiple for batch operations']), action('Open Queries and explore the filters.')),
  buildSlide(4, 'Creating a Query', h2('Raising a Data Question'), ol(['Open patient form','Click query icon next to the field','Select "Create Query"','Enter severity, description, assign to user','Click Create']), tip('Be specific — reference source documents.')),
  buildSlide(5, 'Responding to Queries', h2('Answering Assigned Queries'), ol(['Find query in My Tasks or Queries dashboard','Click to open Query Details','Review question and current value','Type your response','Optionally propose a corrected value','Submit Response']), p('Status changes to "Answered" and returns to originator.')),
  buildSlide(6, 'Query Lifecycle', h2('Full Resolution Flow'), ol(['<strong>Open</strong> — waiting for response','<strong>Answered</strong> — response submitted','<strong>Accepted</strong> — originator accepts','<strong>Rejected</strong> — returned for more info','<strong>Closed</strong> — final (requires e-signature)']), warn('Closing a query requires e-signature.')),
  buildSlide(7, 'Best Practices', h2('Query Guidelines'), ul(['Respond within 48 hours','Be specific with references','Use proposed values when correcting','Check My Tasks daily','Close queries promptly after resolution']), p('<strong>Ready for the quiz!</strong>'))
];
