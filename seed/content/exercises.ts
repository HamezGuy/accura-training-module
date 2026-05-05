/**
 * Interactive exercise configurations for all 15 SOP-based courses.
 * Each exercise is stored as a slide with type='interactive' and interactiveConfig JSON.
 */

interface ExerciseSlide {
  courseCode: string;
  title: string;
  order: number;
  config: Record<string, unknown>;
}

export const courseExercises: ExerciseSlide[] = [
  // ======== LOGIN-NAV ========
  { courseCode: 'LOGIN-NAV', title: 'Exercise: Practice Signing In', order: 3, config: {
    type: 'fill-form', instruction: 'Practice signing in. Fill in the login form below:',
    data: { fields: [
      { label: 'Username', type: 'text', correctAnswer: 'any', placeholder: 'Enter your username', hint: 'Your username was provided by your system administrator' },
      { label: 'Password', type: 'text', correctAnswer: 'any', placeholder: 'Enter a password (8+ characters)', hint: 'Must include uppercase, lowercase, number, and symbol' },
    ]},
    successMessage: 'You have successfully practiced the login flow!', hintMessage: 'Any non-empty value is accepted for this practice exercise.'
  }},
  { courseCode: 'LOGIN-NAV', title: 'Exercise: Navigate the Sidebar', order: 7, config: {
    type: 'sim-action', instruction: 'Click the correct sidebar item to navigate to the Patients page:',
    data: { uiHtml: "<div class='sim-sidebar'><div class='sim-item' data-id='dashboard'>Dashboard</div><div class='sim-item' data-id='tasks'>My Tasks</div><div class='sim-item' data-id='queries'>Queries</div><div class='sim-item' data-id='patients'>Patients</div><div class='sim-item' data-id='forms'>Forms</div><div class='sim-item' data-id='studies'>Studies</div></div>", correctTarget: "[data-id='patients']", incorrectFeedback: 'Not quite. Look for "Patients" in the Clinical section of the sidebar.' },
    successMessage: 'Correct! Patients is in the Clinical section of the sidebar.'
  }},
  { courseCode: 'LOGIN-NAV', title: 'Exercise: Session Timeout Scenario', order: 11, config: {
    type: 'scenario', instruction: 'You have been reading a document for 25 minutes without clicking anything. A warning appears. What should you do?',
    data: { context: 'A popup says: "Your session will expire in 5 minutes due to inactivity. Click Continue to stay signed in."', choices: [
      { text: 'Ignore it and keep reading', correct: false, feedback: 'Incorrect. If you ignore it, you will be signed out after 30 minutes total inactivity and lose unsaved work.' },
      { text: 'Click "Continue" to extend your session', correct: true, feedback: 'Correct! Clicking Continue resets the inactivity timer.' },
      { text: 'Close the browser tab', correct: false, feedback: 'Incorrect. Closing the tab without signing out is not proper procedure and leaves a dangling session.' },
      { text: 'Open a new tab to reset the timer', correct: false, feedback: 'Incorrect. The timer is per-session, not per-tab. You must interact with the current session.' },
    ]},
    successMessage: 'You correctly handled the session timeout warning!'
  }},

  // ======== USER-MGMT ========
  { courseCode: 'USER-MGMT', title: 'Exercise: Create a User Account', order: 4, config: {
    type: 'fill-form', instruction: 'Fill in the form to create a new Coordinator user:',
    data: { fields: [
      { label: 'First Name', type: 'text', correctAnswer: 'any', placeholder: 'Enter first name' },
      { label: 'Last Name', type: 'text', correctAnswer: 'any', placeholder: 'Enter last name' },
      { label: 'Email', type: 'text', correctAnswer: 'any', placeholder: 'user@example.com' },
      { label: 'Role', type: 'dropdown', options: ['Administrator','Data Manager','Investigator','Coordinator','Monitor','Viewer'], correctAnswer: 'Coordinator' },
    ]},
    successMessage: 'Correct! You selected the Coordinator role as instructed.', hintMessage: 'The instructions say to create a Coordinator user. Make sure to select "Coordinator" from the Role dropdown.'
  }},
  { courseCode: 'USER-MGMT', title: 'Exercise: Role Access Levels', order: 6, config: {
    type: 'order-steps', instruction: 'Order these roles from MOST access to LEAST access:',
    data: { steps: [
      { id: 'viewer', text: 'Viewer (Read-only)' },
      { id: 'admin', text: 'Administrator (Full access)' },
      { id: 'monitor', text: 'Monitor (Review access)' },
      { id: 'manager', text: 'Data Manager (High access)' },
      { id: 'coordinator', text: 'Coordinator (Clinical access)' },
      { id: 'investigator', text: 'Investigator (Clinical access)' },
    ], correctOrder: ['admin','manager','investigator','coordinator','monitor','viewer'] },
    successMessage: 'Correct! Administrator has the most access, Viewer has the least.'
  }},

  // ======== DATA-ENTRY ========
  { courseCode: 'DATA-ENTRY', title: 'Exercise: Data Entry Workflow', order: 4, config: {
    type: 'order-steps', instruction: 'Put the data entry steps in the correct order:',
    data: { steps: [
      { id: 'sign', text: 'Apply e-signature (username + password + reason)' },
      { id: 'navigate', text: 'Go to the Patients page' },
      { id: 'enter', text: 'Enter data into form fields' },
      { id: 'select', text: 'Select the patient from the list' },
      { id: 'chip', text: 'Click the form chip for the correct visit' },
      { id: 'submit', text: 'Click Submit & Sign' },
    ], correctOrder: ['navigate','select','chip','enter','submit','sign'] },
    successMessage: 'Correct! Navigate → Select Patient → Click Form → Enter Data → Submit → Sign.'
  }},
  { courseCode: 'DATA-ENTRY', title: 'Exercise: Validation Error Response', order: 7, config: {
    type: 'scenario', instruction: 'A RED validation error appears: "Heart Rate must be between 30 and 250 bpm." You entered 280. What do you do?',
    data: { context: 'The field shows a red border and the error message below. The Submit button is disabled.', choices: [
      { text: 'Delete the value and leave the field blank', correct: false, feedback: 'Incorrect. If it is a required field, leaving it blank will also trigger an error.' },
      { text: 'Change the value to a valid heart rate (e.g., 80)', correct: true, feedback: 'Correct! Fix the value to clear the Block Save error, then you can submit.' },
      { text: 'Click Submit anyway', correct: false, feedback: 'Incorrect. The Submit button is disabled while a Block Save error exists.' },
      { text: 'Close the form and come back later', correct: false, feedback: 'Incorrect. The error will still be there when you return. Fix it now.' },
    ]},
    successMessage: 'You correctly handled the validation error!'
  }},
  { courseCode: 'DATA-ENTRY', title: 'Exercise: Match Form Statuses', order: 3, config: {
    type: 'match-pairs', instruction: 'Match each form chip color to its status meaning:',
    data: { pairs: [
      { left: 'Gray chip', right: 'Not Started' },
      { left: 'Blue chip', right: 'In Progress' },
      { left: 'Green chip', right: 'Complete' },
      { left: 'Purple chip', right: 'Signed' },
      { left: 'Red chip', right: 'Locked' },
    ]},
    successMessage: 'Correct! You can identify form statuses by color.'
  }},

  // ======== FORM-CREATE ========
  { courseCode: 'FORM-CREATE', title: 'Exercise: Form Builder Tabs', order: 4, config: {
    type: 'order-steps', instruction: 'Put the 5 form builder tabs in their correct order (left to right):',
    data: { steps: [
      { id: 'preview', text: 'Preview' },
      { id: 'layout', text: 'Layout' },
      { id: 'info', text: 'Info' },
      { id: 'editchecks', text: 'Edit Checks' },
      { id: 'design', text: 'Design' },
    ], correctOrder: ['info','design','layout','editchecks','preview'] },
    successMessage: 'Correct! Info → Design → Layout → Edit Checks → Preview.'
  }},
  { courseCode: 'FORM-CREATE', title: 'Exercise: Configure a Field', order: 7, config: {
    type: 'fill-form', instruction: 'Configure a "Patient Age" number field with proper settings:',
    data: { fields: [
      { label: 'Field Label', type: 'text', correctAnswer: 'any', placeholder: 'e.g., Patient Age' },
      { label: 'Field Type', type: 'dropdown', options: ['Text','Number','Date','Dropdown','Checkbox'], correctAnswer: 'Number' },
      { label: 'Required?', type: 'radio', options: ['Yes','No'], correctAnswer: 'Yes' },
      { label: 'PHI (Protected Health Info)?', type: 'radio', options: ['Yes','No'], correctAnswer: 'No', hint: 'Age alone is not a HIPAA identifier unless it is over 89' },
    ]},
    successMessage: 'Correct! Age is a Number field, Required, and not PHI (unless over 89).', hintMessage: 'Age should be a Number type and is typically Required for clinical forms.'
  }},

  // ======== PATIENT-MGMT ========
  { courseCode: 'PATIENT-MGMT', title: 'Exercise: Enroll a Patient', order: 4, config: {
    type: 'fill-form', instruction: 'Complete Step 2 of patient enrollment — enter demographics:',
    data: { fields: [
      { label: 'Date of Birth', type: 'date', correctAnswer: 'any', placeholder: 'YYYY-MM-DD' },
      { label: 'Gender', type: 'dropdown', options: ['Male','Female','Other','Unknown'], correctAnswer: 'any' },
      { label: 'Patient Initials', type: 'text', correctAnswer: 'any', placeholder: 'e.g., JD', hint: 'First and last initials only' },
    ]},
    successMessage: 'Demographics entered! In the real system, you would proceed to Step 3: Assignment.'
  }},
  { courseCode: 'PATIENT-MGMT', title: 'Exercise: Identify Patient Statuses', order: 6, config: {
    type: 'highlight', instruction: 'Which of these represents a patient who has COMPLETED their current visit forms?',
    data: { elements: [
      { id: 'gray', label: 'Patient A: All gray chips', correct: false },
      { id: 'mixed', label: 'Patient B: Mix of blue and gray chips', correct: false },
      { id: 'green', label: 'Patient C: All green chips for current visit', correct: true },
      { id: 'locked', label: 'Patient D: Red locked chips', correct: false },
    ]},
    successMessage: 'Correct! All green chips means all forms for the visit are complete.'
  }},

  // ======== VAL-RULES ========
  { courseCode: 'VAL-RULES', title: 'Exercise: Choose Rule Severity', order: 5, config: {
    type: 'scenario', instruction: 'You are creating a validation rule for "Systolic Blood Pressure". The value should be between 60-250 mmHg. Which severity should you choose?',
    data: { context: 'A value outside 60-250 is very unusual but medically possible in extreme cases (e.g., shock, malignant hypertension).', choices: [
      { text: 'Block Save — prevent submission entirely', correct: false, feedback: 'Not ideal. While extreme values are unusual, they can occur in real patients. Blocking save would prevent legitimate data entry.' },
      { text: 'Create Query — allow save but flag for review', correct: true, feedback: 'Correct! For clinically unusual but possible values, use "Create Query" to flag them without blocking data entry.' },
      { text: 'No rule needed', correct: false, feedback: 'Incorrect. A range check is important for data quality — it catches data entry typos like 6000 mmHg.' },
    ]},
    successMessage: 'You chose the right severity! "Create Query" is for unusual-but-possible values.'
  }},
  { courseCode: 'VAL-RULES', title: 'Exercise: Rule Creation Methods', order: 8, config: {
    type: 'match-pairs', instruction: 'Match each rule creation method to its best use case:',
    data: { pairs: [
      { left: 'Quick Add', right: 'Common rules (required, range, format) using 28 pre-built templates' },
      { left: 'AI Suggester', right: 'Intelligent per-field recommendations based on context analysis' },
      { left: 'Custom Rule Builder', right: 'Complex rules needing the 6-step wizard with 30+ check types' },
    ]},
    successMessage: 'Correct! Quick Add for common rules, AI for smart suggestions, Custom for complex logic.'
  }},

  // ======== QUERY-MGMT ========
  { courseCode: 'QUERY-MGMT', title: 'Exercise: Query Lifecycle', order: 4, config: {
    type: 'order-steps', instruction: 'Put the query lifecycle stages in correct order:',
    data: { steps: [
      { id: 'closed', text: 'Closed (e-signature applied)' },
      { id: 'open', text: 'Open (waiting for response)' },
      { id: 'accepted', text: 'Accepted (originator approves)' },
      { id: 'answered', text: 'Answered (response submitted)' },
    ], correctOrder: ['open','answered','accepted','closed'] },
    successMessage: 'Correct! Open → Answered → Accepted → Closed.'
  }},
  { courseCode: 'QUERY-MGMT', title: 'Exercise: Respond to a Query', order: 6, config: {
    type: 'fill-form', instruction: 'A query asks: "Weight of 500 kg seems incorrect. Please verify." The correct weight is 50 kg. Respond:',
    data: { fields: [
      { label: 'Response', type: 'text', correctAnswer: 'any', placeholder: 'Type your response explanation...', hint: 'Reference the source document' },
      { label: 'Proposed Corrected Value', type: 'number', correctAnswer: '50', placeholder: 'Enter correct weight in kg' },
    ]},
    successMessage: 'Correct! You provided the corrected value of 50 kg.', hintMessage: 'The correct weight is 50 kg (the entry had an extra zero).'
  }},

  // ======== DATA-LOCKS ========
  { courseCode: 'DATA-LOCKS', title: 'Exercise: Freeze vs Lock', order: 3, config: {
    type: 'match-pairs', instruction: 'Match each data state to its characteristics:',
    data: { pairs: [
      { left: 'Frozen', right: 'Temporary — can be unfrozen by Data Manager' },
      { left: 'Locked', right: 'Permanent — requires formal unlock request process' },
      { left: 'Open', right: 'Data can be edited freely by authorized users' },
    ]},
    successMessage: 'Correct! Open → Frozen (reversible) → Locked (permanent).'
  }},
  { courseCode: 'DATA-LOCKS', title: 'Exercise: Casebook Readiness', order: 5, config: {
    type: 'highlight', instruction: 'Which of these criteria must be met BEFORE data can be locked?',
    data: { elements: [
      { id: 'queries', label: 'All queries resolved', correct: true },
      { id: 'budget', label: 'Study budget approved', correct: false },
      { id: 'sponsor', label: 'Sponsor site visit completed', correct: false },
      { id: 'published', label: 'Results published in journal', correct: false },
    ]},
    successMessage: 'Correct! All queries must be resolved before data lock. (Also: SDV complete, forms signed, no pending tasks.)'
  }},

  // ======== E-SIGN ========
  { courseCode: 'E-SIGN', title: 'Exercise: E-Signature Components', order: 4, config: {
    type: 'fill-form', instruction: 'Practice applying an e-signature. Enter the three required components:',
    data: { fields: [
      { label: 'Component 1', type: 'dropdown', options: ['Username','Email','Badge ID','Fingerprint'], correctAnswer: 'Username' },
      { label: 'Component 2', type: 'dropdown', options: ['PIN','Password','Security Question','Phone Code'], correctAnswer: 'Password' },
      { label: 'Component 3', type: 'dropdown', options: ['Reason/Meaning','Witness Name','Department','Date'], correctAnswer: 'Reason/Meaning' },
    ]},
    successMessage: 'Correct! E-signatures require: Username + Password + Reason/Meaning.', hintMessage: 'Per 21 CFR Part 11 §11.50: two-component authentication plus the meaning of the signature.'
  }},
  { courseCode: 'E-SIGN', title: 'Exercise: When Is E-Sig Required?', order: 5, config: {
    type: 'highlight', instruction: 'Which of these actions REQUIRES an electronic signature?',
    data: { elements: [
      { id: 'save-draft', label: 'Save form as draft', correct: false },
      { id: 'submit', label: 'Submit a completed CRF form', correct: true },
      { id: 'view-report', label: 'View a report', correct: false },
      { id: 'search', label: 'Search for a patient', correct: false },
    ]},
    successMessage: 'Correct! Submitting a completed form requires e-signature. Drafts, viewing, and searching do not.'
  }},

  // ======== SDV ========
  { courseCode: 'SDV', title: 'Exercise: SDV Process', order: 4, config: {
    type: 'order-steps', instruction: 'Put the SDV verification steps in correct order:',
    data: { steps: [
      { id: 'query', text: 'If discrepancy found: create a query' },
      { id: 'open', text: 'Open patient form marked for SDV' },
      { id: 'compare', text: 'Compare EDC value to source document' },
      { id: 'verify', text: 'If correct: click checkmark to verify' },
      { id: 'find', text: 'Find fields with SDV indicator' },
    ], correctOrder: ['open','find','compare','verify','query'] },
    successMessage: 'Correct! Open form → Find SDV fields → Compare → Verify or Query.'
  }},
  { courseCode: 'SDV', title: 'Exercise: SDV Discrepancy', order: 5, config: {
    type: 'scenario', instruction: 'You are verifying a patient form. The EDC shows Heart Rate = 72 bpm, but the source document shows Heart Rate = 82 bpm. What should you do?',
    data: { context: 'The values do not match: EDC shows 72, source shows 82.', choices: [
      { text: 'Verify it as correct (close enough)', correct: false, feedback: 'Incorrect. Even a 10 bpm difference must be flagged — data must exactly match source documents.' },
      { text: 'Create a query asking the site to investigate and correct', correct: true, feedback: 'Correct! When EDC and source do not match, create a query for the site to resolve.' },
      { text: 'Change the value yourself to 82', correct: false, feedback: 'Incorrect. Monitors cannot directly edit patient data. You must create a query.' },
      { text: 'Ignore it since it is not clinically significant', correct: false, feedback: 'Incorrect. All discrepancies must be documented regardless of clinical significance.' },
    ]},
    successMessage: 'Correct! Always create a query when source and EDC data do not match.'
  }},

  // ======== WORKFLOW ========
  { courseCode: 'WORKFLOW', title: 'Exercise: Workflow Settings', order: 3, config: {
    type: 'match-pairs', instruction: 'Match each workflow setting to what it controls:',
    data: { pairs: [
      { left: 'SDV Required', right: 'Whether monitor must verify the form data' },
      { left: 'DDE Required', right: 'Whether double data entry is needed' },
      { left: 'Signature Required', right: 'Whether e-signature is needed on submission' },
      { left: 'Query Routing', right: 'Who receives auto-generated queries' },
    ]},
    successMessage: 'Correct! Each form can have these workflow requirements configured independently.'
  }},
  { courseCode: 'WORKFLOW', title: 'Exercise: Task Types', order: 5, config: {
    type: 'highlight', instruction: 'Which task type would appear in My Tasks when a validation rule creates an automatic query?',
    data: { elements: [
      { id: 'data-entry', label: 'Data Entry task', correct: false },
      { id: 'query-response', label: 'Query Response task', correct: true },
      { id: 'signature', label: 'E-Signature task', correct: false },
      { id: 'sdv', label: 'SDV Verification task', correct: false },
    ]},
    successMessage: 'Correct! Auto-generated queries appear as Query Response tasks for the assigned user.'
  }},

  // ======== DATA-EXPORT ========
  { courseCode: 'DATA-EXPORT', title: 'Exercise: Choose Export Format', order: 3, config: {
    type: 'scenario', instruction: 'You need to export data for FDA regulatory submission. Which format should you choose?',
    data: { context: 'The sponsor requests data in the FDA-preferred electronic format for a New Drug Application (NDA).', choices: [
      { text: 'Excel (.xlsx)', correct: false, feedback: 'Incorrect. Excel is good for ad-hoc analysis but not FDA-preferred for formal submissions.' },
      { text: 'CSV (.csv)', correct: false, feedback: 'Incorrect. CSV is for statistical analysis in SAS/R but not the FDA-preferred submission format.' },
      { text: 'ODM XML', correct: true, feedback: 'Correct! ODM XML (Operational Data Model) is the FDA-preferred format for electronic regulatory submissions.' },
      { text: 'PDF', correct: false, feedback: 'Incorrect. PDF is for printing and archival, not electronic data submission.' },
    ]},
    successMessage: 'Correct! ODM XML is the FDA standard for electronic submissions.'
  }},

  // ======== REPORTS ========
  { courseCode: 'REPORTS', title: 'Exercise: Report Selection', order: 3, config: {
    type: 'match-pairs', instruction: 'Match each analysis need to the correct report type:',
    data: { pairs: [
      { left: 'How many patients have been enrolled per site?', right: 'Enrollment Dashboard' },
      { left: 'What percentage of forms have missing data?', right: 'Data Quality Report' },
      { left: 'How long does it take to respond to queries?', right: 'Query Analytics' },
    ]},
    successMessage: 'Correct! Each question maps to a specific report type.'
  }},

  // ======== RANDOMIZE ========
  { courseCode: 'RANDOMIZE', title: 'Exercise: Pre-Randomization Checklist', order: 4, config: {
    type: 'highlight', instruction: 'What MUST you verify before clicking the Randomize button for a patient?',
    data: { elements: [
      { id: 'eligible', label: 'Patient meets eligibility criteria', correct: true },
      { id: 'budget', label: 'Site has remaining budget', correct: false },
      { id: 'weather', label: 'Good weather for patient travel', correct: false },
      { id: 'insurance', label: 'Insurance pre-authorization obtained', correct: false },
    ]},
    successMessage: 'Correct! Eligibility must be confirmed before randomization. It cannot be undone!'
  }},
  { courseCode: 'RANDOMIZE', title: 'Exercise: Emergency Unblinding', order: 5, config: {
    type: 'scenario', instruction: 'A patient in a double-blind trial has a severe allergic reaction. The treating physician needs to know the treatment assignment. What is the correct procedure?',
    data: { context: 'The patient is in the emergency department. The physician believes knowing the treatment arm is medically necessary for appropriate care.', choices: [
      { text: 'Call the sponsor and wait for approval', correct: false, feedback: 'Incorrect. In a medical emergency, waiting for sponsor approval could endanger the patient.' },
      { text: 'Use Emergency Unblind with dual authorization (two e-signatures)', correct: true, feedback: 'Correct! Emergency unblinding requires two authorized users to authenticate, and the event is logged.' },
      { text: 'Guess based on the patient symptoms', correct: false, feedback: 'Incorrect. Guessing is not reliable and does not follow protocol.' },
      { text: 'Break the sealed envelope from the site file', correct: false, feedback: 'Incorrect. AccuraTrial uses electronic sealed lists, not paper envelopes. Use the Emergency Unblind feature.' },
    ]},
    successMessage: 'Correct! Emergency unblinding requires dual authorization and is fully audited.'
  }},

  // ======== STUDY-MGMT ========
  { courseCode: 'STUDY-MGMT', title: 'Exercise: Study Wizard Tabs', order: 4, config: {
    type: 'order-steps', instruction: 'Put the 8 Study Creation wizard tabs in correct order:',
    data: { steps: [
      { id: 'visits', text: 'Visits' },
      { id: 'basic', text: 'Basic Info' },
      { id: 'settings', text: 'Settings' },
      { id: 'protocol', text: 'Protocol' },
      { id: 'facilities', text: 'Facilities' },
      { id: 'groups', text: 'Groups' },
      { id: 'design', text: 'Design' },
      { id: 'eligibility', text: 'Eligibility' },
    ], correctOrder: ['basic','facilities','protocol','eligibility','design','visits','groups','settings'] },
    successMessage: 'Correct! The 8-tab wizard follows: Basic Info → Facilities → Protocol → Eligibility → Design → Visits → Groups → Settings.'
  }},
  { courseCode: 'STUDY-MGMT', title: 'Exercise: Create a Study', order: 6, config: {
    type: 'fill-form', instruction: 'Fill in the Basic Info tab for a new Phase III Oncology study:',
    data: { fields: [
      { label: 'Study Name', type: 'text', correctAnswer: 'any', placeholder: 'e.g., ONCO-2026 Phase III Trial' },
      { label: 'Protocol Number', type: 'text', correctAnswer: 'any', placeholder: 'e.g., PROT-2026-001' },
      { label: 'Phase', type: 'dropdown', options: ['Phase I','Phase II','Phase III','Phase IV'], correctAnswer: 'Phase III' },
      { label: 'Therapeutic Area', type: 'dropdown', options: ['Cardiology','Oncology','Neurology','Infectious Disease','Dermatology'], correctAnswer: 'Oncology' },
    ]},
    successMessage: 'Correct! You selected Phase III and Oncology as specified.', hintMessage: 'The instructions say Phase III Oncology study.'
  }},
];
