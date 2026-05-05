import { Quiz } from './helpers';

function mc(text: string, options: [string, boolean][], explanation: string, order: number): Quiz {
  return { text, type: 'multiple_choice', options: options.map(([t, c]) => ({ text: t, isCorrect: c })), explanation, order };
}
function tf(text: string, correct: boolean, explanation: string, order: number): Quiz {
  return { text, type: 'true_false', options: [{ text: 'True', isCorrect: correct }, { text: 'False', isCorrect: !correct }], explanation, order };
}

export const courseQuizzes: Record<string, Quiz[]> = {
  'LOGIN-NAV': [
    mc('What happens after 5 failed login attempts?', [['Account is deleted', false], ['15-minute lockout', true], ['Password is reset', false], ['Admin is notified only', false]], 'Per 21 CFR Part 11 §11.300(d), 5 failed attempts triggers a 15-minute lockout.', 1),
    mc('After how many minutes of inactivity does the session timeout?', [['15 minutes', false], ['30 minutes', true], ['60 minutes', false], ['Never', false]], 'Sessions timeout after 30 minutes of inactivity per 21 CFR Part 11 requirements.', 2),
    tf('You can safely close the browser tab instead of clicking Sign Out.', false, 'Always use the Sign Out button for proper audit trail logging.', 3),
    mc('Which section of the sidebar is only visible to Administrators?', [['Main section', false], ['Clinical section', false], ['Admin section', true], ['All sections are visible to everyone', false]], 'The Admin section (Users, Settings) is only visible to Administrator role.', 4),
    mc('Where should you check first each day when logging in?', [['Reports', false], ['My Tasks', true], ['Studies', false], ['Forms', false]], 'My Tasks aggregates all pending work items requiring your attention.', 5),
  ],
  'USER-MGMT': [
    mc('How many system roles are available in AccuraTrial?', [['4', false], ['5', false], ['6', true], ['8', false]], 'Six roles: Administrator, Data Manager, Investigator, Coordinator, Monitor, Viewer.', 1),
    tf('Users should be deleted when they leave the organization.', false, 'Per 21 CFR Part 11, users should be deactivated (not deleted) to preserve audit trail integrity.', 2),
    mc('How many granular permissions are available beyond role-based access?', [['12', false], ['24', false], ['42', true], ['100', false]], 'AccuraTrial provides 42 individual permissions that can be toggled per user.', 3),
    mc('What is the password expiration policy?', [['30 days', false], ['60 days', false], ['90 days', true], ['Never expires', false]], 'Passwords expire every 90 days per security policy.', 4),
    tf('Only Administrators can create new user accounts.', true, 'User management is restricted to the Administrator role.', 5),
  ],
  'STUDY-MGMT': [
    mc('How many tabs does the Study Creation wizard have?', [['4', false], ['6', false], ['8', true], ['10', false]], 'The wizard has 8 tabs: Basic Info, Facilities, Protocol, Eligibility, Design, Visits, Groups, Settings.', 1),
    mc('Where do you assign CRF forms to specific visits?', [['Study wizard', false], ['Event-CRF Assignment page', true], ['Form builder', false], ['Patient record', false]], 'Forms are assigned to visits via the Event-CRF Assignment page after study creation.', 2),
    tf('Study parameters can be freely changed after patient enrollment begins.', false, 'Changes after enrollment may require a protocol amendment.', 3),
    mc('Which roles can create new studies?', [['All roles', false], ['Admin and Manager only', true], ['Admin only', false], ['Admin, Manager, and Coordinator', false]], 'Only Administrators and Managers can create and modify studies.', 4),
    mc('What defines when data is collected for each patient?', [['Forms', false], ['Visits/Events', true], ['Sites', false], ['Groups', false]], 'Visits define the scheduled timepoints when data collection occurs.', 5),
  ],
  'FORM-CREATE': [
    mc('How many field types are available in the form builder?', [['20', false], ['45', false], ['78+', true], ['100+', false]], 'AccuraTrial offers 78+ field types across 7 categories.', 1),
    mc('What are the 5 tabs in the form builder?', [['Info, Fields, Styles, Logic, Save', false], ['Info, Design, Layout, Edit Checks, Preview', true], ['Create, Edit, View, Test, Publish', false], ['Header, Body, Footer, Rules, Submit', false]], 'The builder has: Info, Design, Layout, Edit Checks, and Preview tabs.', 2),
    tf('Variable names can be changed after a form is published.', false, 'Variable names are permanent after publishing to maintain data integrity.', 3),
    mc('What is required to save a form template?', [['Admin approval', false], ['Electronic signature', true], ['Two witnesses', false], ['Nothing special', false]], 'Per 21 CFR Part 11, saving form templates requires an e-signature.', 4),
    mc('What happens when you edit a published form?', [['Original is overwritten', false], ['A new version is created', true], ['Edit is blocked', false], ['Admin approval needed first', false]], 'Published forms are versioned — edits create a new version; the original is preserved.', 5),
  ],
  'DATA-ENTRY': [
    mc('What is the correct navigation path to enter data?', [['Forms → Select Form → Enter Data', false], ['Patients → Select Patient → Visit → Form Chip', true], ['Studies → Visit → Patient → Form', false], ['My Tasks → Form → Enter', false]], 'Per SOP-029: navigate Patients → Select Patient → Find Visit → Click Form Chip.', 1),
    mc('What does a RED validation error mean?', [['Data is unusual but acceptable', false], ['Blocks form submission until fixed', true], ['Creates a query automatically', false], ['Warning only — can be ignored', false]], 'Red errors (Block Save) prevent submission. They must be corrected.', 2),
    mc('What does a YELLOW validation warning do?', [['Blocks submission', false], ['Allows save but creates a query automatically', true], ['Is informational only', false], ['Requires admin override', false]], 'Yellow warnings allow save but auto-generate a data query for follow-up.', 3),
    tf('After submitting a form, corrections do not require any explanation.', false, 'All corrections require a Reason for Change that is recorded in the audit trail.', 4),
    mc('What three things must you provide for an e-signature?', [['Name, email, PIN', false], ['Username, password, reason', true], ['ID badge, fingerprint, password', false], ['Password, security question, PIN', false]], 'E-signatures require username + password + reason/meaning per 21 CFR Part 11.', 5),
  ],
  'PATIENT-MGMT': [
    mc('How many steps are in the patient enrollment wizard?', [['2', false], ['3', true], ['4', false], ['5', false]], 'The enrollment wizard has 3 steps: Subject ID, Demographics, Assignment.', 1),
    mc('What do form chip colors indicate?', [['Priority level', false], ['Form completion status', true], ['Query count', false], ['Field type', false]], 'Chip colors show status: gray=not started, blue=in progress, green=complete, purple=signed.', 2),
    tf('Subject IDs are always manually entered by the user.', false, 'Subject IDs can be auto-generated or manual, depending on study configuration.', 3),
    mc('What type of visit can be added outside the scheduled protocol visits?', [['Emergency visit', false], ['Unscheduled visit', true], ['Ad-hoc visit', false], ['Override visit', false]], 'Unscheduled visits can be added for adverse events, early termination, etc.', 4),
    mc('Where do you see a patient visit timeline with form chips?', [['The Studies page', false], ['Patient Detail View', true], ['The Dashboard', false], ['Reports', false]], 'The Patient Detail View shows visit columns with form chips per visit.', 5),
  ],
  'VAL-RULES': [
    mc('How many methods are available to create validation rules?', [['1', false], ['2', false], ['3', true], ['5', false]], 'Three methods: Quick Add (28 templates), AI Suggester, and Custom Rule Builder.', 1),
    mc('What is the difference between Block Save and Create Query severity?', [['Block Save is for warnings only', false], ['Block Save prevents submission; Create Query allows save but generates a query', true], ['They are the same thing', false], ['Create Query blocks submission', false]], 'Block Save = hard error (must fix). Create Query = soft warning (saves but auto-generates query).', 2),
    tf('The AI Rule Suggester can analyze field context to suggest appropriate rules.', true, 'The AI Suggester analyzes field name, type, and context to provide intelligent rule suggestions.', 3),
    mc('What is required when modifying validation rules?', [['Admin approval', false], ['Electronic signature', true], ['Two-person verification', false], ['Nothing special', false]], 'Per 21 CFR Part 11, all validation rule changes require an e-signature.', 4),
    mc('How many check types are available in the Custom Rule Builder mega-dropdown?', [['10', false], ['20', false], ['30+', true], ['5', false]], 'The mega-dropdown offers 30+ check types organized in 11 groups.', 5),
  ],
  'QUERY-MGMT': [
    mc('What are the possible query statuses in order?', [['New, Pending, Done', false], ['Open, Answered, Accepted/Rejected, Closed', true], ['Created, Assigned, Resolved', false], ['Draft, Sent, Received, Complete', false]], 'Query lifecycle: Open → Answered → Accepted/Rejected → Closed.', 1),
    tf('Queries can be closed without an electronic signature.', false, 'Closing a query requires e-signature per 21 CFR Part 11.', 2),
    mc('How are validation-generated queries assigned?', [['Always to the admin', false], ['Based on workflow routing configuration', true], ['To the person who entered data', false], ['Randomly', false]], 'Auto-generated queries follow the query routing rules in workflow configuration.', 3),
    mc('What is the recommended response time for queries?', [['24 hours', false], ['48 hours', true], ['7 days', false], ['No deadline', false]], 'Best practice is to respond to queries within 48 hours.', 4),
    mc('What can you do when responding to a query?', [['Only type a text response', false], ['Respond AND propose a corrected data value', true], ['Only close it', false], ['Only reject it', false]], 'Respondents can provide explanation and optionally propose a corrected value.', 5),
  ],
  'DATA-LOCKS': [
    mc('What is the difference between Frozen and Locked data?', [['They are the same', false], ['Frozen is reversible; Locked is permanent', true], ['Locked is reversible; Frozen is permanent', false], ['Neither can be reversed', false]], 'Frozen can be unfrozen by a Data Manager. Locked is permanent (requires formal unlock request).', 1),
    mc('What must be complete before data can be locked?', [['Only form submission', false], ['All queries resolved, SDV complete, forms signed', true], ['Admin approval only', false], ['Nothing — any data can be locked', false]], 'Casebook readiness requires: forms signed, queries closed, SDV complete, no pending tasks.', 2),
    tf('Study-level database lock can be easily reversed.', false, 'Study lock is irreversible without formal protocol amendment.', 3),
    mc('Who can approve unlock requests?', [['Any user', false], ['Data Manager or Administrator', true], ['Only the sponsor', false], ['The original data entry person', false]], 'Data Managers and Administrators review and approve unlock requests.', 4),
    mc('What is required to freeze or lock data?', [['Admin approval email', false], ['Electronic signature', true], ['Two-person authorization', false], ['Nothing', false]], 'All freeze/lock actions require e-signature for audit compliance.', 5),
  ],
  'E-SIGN': [
    mc('What makes an e-signature legally binding under 21 CFR Part 11?', [['Just clicking a button', false], ['Username + password + reason (two-component auth)', true], ['Email confirmation', false], ['Biometric scan', false]], 'Per §11.50, e-signatures require two-component authentication plus meaning.', 1),
    tf('If signed data is modified, the original signature remains valid.', false, 'Signatures are automatically invalidated when signed data changes. A new signature is required.', 2),
    mc('Which action does NOT require an e-signature?', [['Submitting a completed form', false], ['Saving a form as draft', true], ['Closing a query', false], ['Locking data', false]], 'Save Draft does not require a signature — only final submission and other controlled actions do.', 3),
    mc('What is recorded with every e-signature?', [['Just the username', false], ['Who signed, when (UTC), what was signed, and why', true], ['Only the timestamp', false], ['A hash of the document', false]], 'Complete signature manifestation includes signer identity, timestamp, signed content, and meaning.', 4),
    tf('E-signatures in AccuraTrial are equivalent to handwritten signatures.', true, 'Per 21 CFR Part 11, compliant e-signatures are legally equivalent to handwritten signatures.', 5),
  ],
  'SDV': [
    mc('What does SDV verify?', [['That the software works correctly', false], ['That EDC data matches source documents', true], ['That patients exist', false], ['That forms are complete', false]], 'SDV ensures CRF data matches original source documents (medical charts, lab reports).', 1),
    mc('Who performs SDV?', [['Data Manager', false], ['Monitor', true], ['Investigator', false], ['Coordinator', false]], 'SDV is performed by the Monitor role during monitoring visits.', 2),
    tf('All fields in every form require SDV.', false, 'SDV-required fields are defined by the study protocol and monitoring plan.', 3),
    mc('What should you do if SDV reveals a discrepancy?', [['Correct the data yourself', false], ['Create a query on the field', true], ['Ignore it if minor', false], ['Email the coordinator', false]], 'If source and EDC data do not match, create a query for the site to investigate.', 4),
    mc('When must SDV be complete?', [['Before patient enrollment', false], ['Before database lock', true], ['Within 24 hours of data entry', false], ['Before study start', false]], 'SDV must be 100% complete (for required fields) before data lock.', 5),
  ],
  'WORKFLOW': [
    mc('Which per-form workflow settings can be configured?', [['Only signature requirements', false], ['SDV, DDE, Signature, and Query Routing', true], ['Only query routing', false], ['Only DDE settings', false]], 'Each form can have SDV Required, DDE Required, Signature Required, and Query Routing configured.', 1),
    mc('How many task types exist in My Tasks?', [['3', false], ['5', false], ['7', true], ['10', false]], 'Seven task types: Data Entry, Query Response, E-Signature, SDV, DDE Resolution, Approval, Review.', 2),
    tf('Query routing determines who receives automatically-generated queries.', true, 'Workflow query routing rules control assignment of validation-generated queries.', 3),
    mc('What are the query routing options?', [['By Role, By User, By Form Owner, Escalation', true], ['Only By Role', false], ['Only By User', false], ['By Department only', false]], 'Four routing options: By Role, By User, By Form Owner, and Escalation after X days.', 4),
    mc('When should workflow configuration be completed?', [['After study enrollment begins', false], ['Before study enrollment begins', true], ['During database lock', false], ['Anytime', false]], 'Configure workflows before enrollment to ensure consistent task assignment from the start.', 5),
  ],
  'DATA-EXPORT': [
    mc('Which format is FDA-preferred for regulatory submissions?', [['Excel', false], ['CSV', false], ['ODM XML', true], ['PDF', false]], 'ODM XML (Operational Data Model) is the FDA-preferred electronic submission format.', 1),
    mc('Which format is best for statistical analysis in SAS or R?', [['PDF', false], ['ODM XML', false], ['CSV', true], ['Tab-delimited', false]], 'CSV is the standard format for statistical analysis software (SAS, R, Python).', 2),
    tf('Anonymized exports remove all 18 HIPAA identifiers.', true, 'Anonymization strips all 18 HIPAA-defined identifiers from exported data.', 3),
    mc('What option exports only finalized records?', [['Include Audit Trail', false], ['Locked Data Only', true], ['Include Signatures', false], ['Anonymize', false]], 'The "Locked Data Only" option exports only locked/final records ready for submission.', 4),
    tf('Any user can export data regardless of role.', false, 'Only authorized roles (Admin, Manager, Monitor, Viewer) can perform data exports.', 5),
  ],
  'REPORTS': [
    mc('Which report shows screening vs enrollment funnel?', [['Data Quality', false], ['Enrollment Dashboard', true], ['Query Analytics', false], ['Compliance', false]], 'The Enrollment Dashboard shows the screening-to-enrollment funnel and trends.', 1),
    mc('What does the Data Quality report track?', [['User login frequency', false], ['Missing data, query rates, validation failures', true], ['Site addresses', false], ['Study budget', false]], 'Data Quality reports show missing data percentage, query rates, and validation failure patterns.', 2),
    tf('Reports content is the same for all user roles.', false, 'Report content varies by role — administrators see more than viewers.', 3),
    mc('How often should Data Quality reports be reviewed?', [['Daily', false], ['Weekly', true], ['Monthly', false], ['Only at study end', false]], 'Best practice: review data quality weekly to catch systematic issues early.', 4),
    tf('Reports are available from the sidebar under the main navigation.', true, 'Click Reports in the sidebar to access all report types.', 5),
  ],
  'RANDOMIZE': [
    mc('Which randomization algorithms are supported?', [['Simple only', false], ['Simple, block, stratified, minimization', true], ['Only block randomization', false], ['External RTSM only', false]], 'Four algorithms: simple, block, stratified, and minimization.', 1),
    tf('Randomization can be undone after it is executed.', false, 'Randomization cannot be reversed once executed. Verify eligibility carefully.', 2),
    mc('How many authorized users are required for emergency unblinding?', [['1', false], ['2', true], ['3', false], ['The entire team', false]], 'Emergency unblinding requires dual authorization (two e-signatures).', 3),
    mc('What ensures allocation concealment in AccuraTrial?', [['Password protection', false], ['Sealed randomization lists', true], ['Blinded site staff', false], ['Encrypted databases', false]], 'Sealed lists ensure assignments are only revealed at the moment of randomization.', 4),
    mc('When must randomization configuration be locked?', [['After study ends', false], ['Before first patient is randomized', true], ['After 50% enrollment', false], ['Never — it can always be changed', false]], 'Configuration must be locked before the first randomization to prevent bias.', 5),
  ],
};
