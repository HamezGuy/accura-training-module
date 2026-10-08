import { getComplianceStatus, getCourses, createCourse, updateCourse } from '../../src/services/training.service';
const mockQuery = jest.fn(), mockQueryOne = jest.fn();
const mockDirectory = jest.fn(), mockRevalidate = jest.fn();
const authority = { actorUserId: 7, accessToken: 'fixture-native-token' };
jest.mock('../../src/services/training-authority.service', () => ({
  readTrainingDirectory: (...args: unknown[]) => mockDirectory(...args),
  revalidateTrainingDirectory: (...args: unknown[]) => mockRevalidate(...args),
}));
jest.mock('../../src/config/database', () => ({ query: (...args: unknown[]) => mockQuery(...args), queryOne: (...args: unknown[]) => mockQueryOne(...args) }));
jest.mock('../../src/config/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../src/services/certificate.service', () => ({}));

describe('native compliance identity and required-course census', () => {
  const user = { userId: 7, username: 'owned', firstName: 'Owned', lastName: 'User', role: 'monitor' };
  const course = (id: number, roles = ['monitor']) => ({ id, courseCode: `C-${id}`, courseName: `Course ${id}`, requiredForRoles: roles });
  function fixture(users: unknown[], courses: unknown[], records: unknown[]) {
    mockDirectory.mockResolvedValue({ users, filter: {}, scopeFingerprint: 'fixture-scope' });
    mockQuery.mockResolvedValueOnce({ rows: courses }).mockResolvedValueOnce({ rows: records });
  }
  beforeEach(() => { mockQuery.mockReset(); mockQueryOne.mockReset(); mockDirectory.mockReset(); mockRevalidate.mockReset(); mockRevalidate.mockResolvedValue(undefined); });
  test('optional, obsolete and same-code records cannot change a required ID census', async () => {
    fixture([user], [course(1), course(2)], [
      { courseId: 1, status: 'completed', expirationDate: '2099-01-01' },
      { courseId: 9, courseCode: 'C-2', status: 'completed' },
      { courseId: 10, status: 'expired' },
    ]);
    const [status] = await getComplianceStatus(authority, { userId: 7 });
    expect(status).toMatchObject({ totalRequired: 2, completed: 1, expired: 0, pending: 1, compliancePercentage: 50, isCompliant: false });
    expect(status.missingCourses.map(row => row.courseCode)).toEqual(['C-2']);
    expect(mockQuery.mock.calls[1][1]).toEqual([7, [1, 2]]);
    expect(mockDirectory).toHaveBeenCalledWith(authority, { userId: 7 });
    expect(mockQuery.mock.calls.every(([sql]) => !/user_account|study_user_role|acc_organization/.test(sql))).toBe(true);
  });
  test('unrelated expired records cannot invalidate completed required training', async () => {
    fixture([user], [course(1)], [{ courseId: 1, status: 'completed' }, { courseId: 9, status: 'expired' }]);
    expect((await getComplianceStatus(authority, { userId: 7 }))[0]).toMatchObject({ completed: 1, expired: 0, pending: 0, compliancePercentage: 100, isCompliant: true });
  });
  test.each(['admin', 'data_manager', 'coordinator'])('uses the native resolved role %s without reconstructing authority', async role => {
    fixture([{ ...user, role }], [course(1, [role === 'data_manager' ? 'manager' : role])], []);
    expect((await getComplianceStatus(authority, { userId: 7 }))[0]).toMatchObject({ role, totalRequired: 1, completed: 0, isCompliant: false });
  });
  test('refuses an invalid explicit native role instead of declaring zero required courses', async () => {
    const refusal = Object.assign(new Error('Unknown native platform role for training compliance'), { statusCode: 409 });
    mockDirectory.mockRejectedValue(refusal);
    await expect(getComplianceStatus(authority, { userId: 7 })).rejects.toBe(refusal);
  });
  test.each([0, NaN, -1, 1.5])('rejects invalid study filter %s before any SQL', async studyId => {
    await expect(getComplianceStatus(authority, { studyId, userId: 7 })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled(); expect(mockQueryOne).not.toHaveBeenCalled();
  });
  test('missing study cannot fall back to all users', async () => {
    mockDirectory.mockRejectedValue(Object.assign(new Error('Study not found for training compliance'), { statusCode: 404 }));
    await expect(getComplianceStatus(authority, { studyId: 7, userId: 7 })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockQuery).not.toHaveBeenCalled();
  });
  test('supplied study scope and user identity are bound independently', async () => {
    fixture([user], [], []);
    await getComplianceStatus(authority, { studyId: 5, userId: 7 });
    expect(mockDirectory).toHaveBeenCalledWith(authority, { studyId: 5, userId: 7 });
  });
  test('duplicate required records are an error, never double credit', async () => {
    fixture([user], [course(1)], [{ courseId: 1, status: 'completed' }, { courseId: 1, status: 'completed' }]);
    await expect(getComplianceStatus(authority, { userId: 7 })).rejects.toMatchObject({ statusCode: 409 });
  });
  test.each(['data_manager', 'manager', 'study_director'])('course lists retain legacy and canonical requirements for %s', async role => {
    mockQuery.mockResolvedValue({ rows: [course(1,['manager']), course(2,['data_manager']), course(3,['study_director']), course(4,['monitor'])] });
    expect((await getCourses({ role })).map(row => row.id)).toEqual([1,2,3]);
  });
  test.each([['invented'], ['constructor'], ['__proto__'], [''], [7], 'manager', null].map(roles => ({roles})))('stored malformed roles $roles fail instead of reporting complete compliance', async ({roles}) => {
    fixture([user], [{...course(1),requiredForRoles:roles}], []);
    await expect(getComplianceStatus(authority, { userId: 7 })).rejects.toMatchObject({ statusCode:409 });
  });
  test.each([['invented'], ['constructor'], ['__proto__'], [7], 'manager', null].map(roles => ({roles})))('course mutations refuse malformed roles $roles before writes', async ({roles}) => {
    await expect(createCourse({ requiredForRoles: roles } as any, 7)).rejects.toMatchObject({ statusCode:400 });
    await expect(updateCourse(1, { requiredForRoles: roles } as any)).rejects.toMatchObject({ statusCode:400 });
    expect(mockQuery).not.toHaveBeenCalled(); expect(mockQueryOne).not.toHaveBeenCalled();
  });

});
