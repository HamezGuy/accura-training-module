export interface LearningPath {
  id: string;
  name: string;
  description: string;
  targetRole: string;
  courseCodes: string[];
  totalMinutes: number;
}

export const LEARNING_PATHS: LearningPath[] = [
  {
    id: 'coordinator-path',
    name: 'Site Coordinator Path',
    description: 'Essential training for Clinical Research Coordinators — data entry, patient management, queries, and e-signatures.',
    targetRole: 'coordinator',
    courseCodes: ['LOGIN-NAV', 'DATA-ENTRY', 'PATIENT-MGMT', 'QUERY-MGMT', 'E-SIGN'],
    totalMinutes: 115,
  },
  {
    id: 'monitor-path',
    name: 'Clinical Monitor Path',
    description: 'Training for CRAs and monitors — source data verification, query management, data locks, and reporting.',
    targetRole: 'monitor',
    courseCodes: ['LOGIN-NAV', 'SDV', 'QUERY-MGMT', 'DATA-LOCKS', 'REPORTS'],
    totalMinutes: 115,
  },
  {
    id: 'data-manager-path',
    name: 'Data Manager Path',
    description: 'Comprehensive training for data managers — form design, validation rules, workflows, data locks, and exports.',
    targetRole: 'manager',
    courseCodes: ['LOGIN-NAV', 'FORM-CREATE', 'VAL-RULES', 'WORKFLOW', 'DATA-LOCKS', 'DATA-EXPORT', 'QUERY-MGMT'],
    totalMinutes: 200,
  },
  {
    id: 'investigator-path',
    name: 'Principal Investigator Path',
    description: 'Training for investigators — data entry, patient management, randomization, and electronic signatures.',
    targetRole: 'investigator',
    courseCodes: ['LOGIN-NAV', 'DATA-ENTRY', 'PATIENT-MGMT', 'RANDOMIZE', 'E-SIGN'],
    totalMinutes: 115,
  },
  {
    id: 'admin-path',
    name: 'System Administrator Path',
    description: 'Complete system training covering all features plus regulatory compliance courses.',
    targetRole: 'admin',
    courseCodes: ['LOGIN-NAV', 'USER-MGMT', 'STUDY-MGMT', 'FORM-CREATE', 'DATA-ENTRY', 'PATIENT-MGMT', 'VAL-RULES', 'QUERY-MGMT', 'DATA-LOCKS', 'E-SIGN', 'SDV', 'WORKFLOW', 'DATA-EXPORT', 'REPORTS', 'RANDOMIZE', 'GCP-101', 'CFR11-101', 'HIPAA-101'],
    totalMinutes: 420,
  },
];
