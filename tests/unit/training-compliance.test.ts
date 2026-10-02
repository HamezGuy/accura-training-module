import { getComplianceStatus, getCourses, createCourse, updateCourse } from '../../src/services/training.service';
const mockQuery = jest.fn(), mockQueryOne = jest.fn();
jest.mock('../../src/config/database', () => ({ query: (...args: unknown[]) => mockQuery(...args), queryOne: (...args: unknown[]) => mockQueryOne(...args) }));
jest.mock('../../src/config/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../src/services/certificate.service', () => ({}));

describe('native compliance identity and required-course census', () => {
  const user = { userId: 7, username: 'owned', firstName: 'Owned', lastName: 'User', userTypeId: 2, platformRole: 'monitor', studyRoles: [] };
  const course = (id: number, roles = ['monitor']) => ({ id, courseCode: `C-${id}`, courseName: `Course ${id}`, requiredForRoles: roles });
  function fixture(users: unknown[], courses: unknown[], records: unknown[]) {
    mockQuery.mockResolvedValueOnce({ rows: users }).mockResolvedValueOnce({ rows: courses }).mockResolvedValueOnce({ rows: records });
  }
  beforeEach(() => { mockQuery.mockReset(); mockQueryOne.mockReset(); });
  test('optional, obsolete and same-code records cannot change a required ID census', async () => {
    fixture([user], [course(1), course(2)], [
      { courseId: 1, status: 'completed', expirationDate: '2099-01-01' },
      { courseId: 9, courseCode: 'C-2', status: 'completed' },
      { courseId: 10, status: 'expired' },
    ]);
    const [status] = await getComplianceStatus({ userId: 7 });
    expect(status).toMatchObject({ totalRequired: 2, completed: 1, expired: 0, pending: 1, compliancePercentage: 50, isCompliant: false });
    expect(status.missingCourses.map(row => row.courseCode)).toEqual(['C-2']);
    expect(mockQuery.mock.calls[2][1]).toEqual([7, [1, 2]]);
    expect(mockQuery.mock.calls[0][0]).toContain('FROM user_account');
  });
  test('unrelated expired records cannot invalidate completed required training', async () => {
    fixture([user], [course(1)], [{ courseId: 1, status: 'completed' }, { courseId: 9, status: 'expired' }]);
    expect((await getComplianceStatus())[0]).toMatchObject({ completed: 1, expired: 0, pending: 0, compliancePercentage: 100, isCompliant: true });
  });
  test.each([
    [{ userTypeId: 1, platformRole: 'monitor' }, 'admin'],
    [{ platformRole: 'study_director', studyRoles: ['admin'] }, 'data_manager'],
    [{ platformRole: null, studyRoles: ['ra', 'site_monitor'] }, 'coordinator'],
    [{ platformRole: null, studyRoles: [] }, 'coordinator'],
  ])('matches native primary-role precedence %j', async (changes, role) => {
    fixture([{ ...user, ...changes }], [course(1, [role === 'data_manager' ? 'manager' : role])], []);
    expect((await getComplianceStatus())[0]).toMatchObject({ role, totalRequired: 1, completed: 0, isCompliant: false });
  });
  test('refuses an invalid explicit native role instead of declaring zero required courses', async () => {
    fixture([{ ...user, platformRole: 'unknown' }], [], []);
    await expect(getComplianceStatus()).rejects.toMatchObject({ statusCode: 409 });
  });
  test.each([0, NaN, -1, 1.5])('rejects invalid study filter %s before any SQL', async studyId => {
    await expect(getComplianceStatus({ studyId })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockQuery).not.toHaveBeenCalled(); expect(mockQueryOne).not.toHaveBeenCalled();
  });
  test('missing study cannot fall back to all users', async () => {
    mockQueryOne.mockResolvedValue(null);
    await expect(getComplianceStatus({ studyId: 7 })).rejects.toMatchObject({ statusCode: 404 });
    expect(mockQuery).not.toHaveBeenCalled();
  });
  test('supplied study scope and user identity are bound independently', async () => {
    mockQueryOne.mockResolvedValue({ studyId: 5 }); fixture([user], [], []);
    await getComplianceStatus({ studyId: 5, userId: 7 });
    expect(mockQuery.mock.calls[0][1]).toEqual([5, 7]);
    expect(mockQuery.mock.calls[0][0]).toContain('parent_study_id = $1');
    expect(mockQuery.mock.calls[0][0]).toContain('scoped.status_id = 1');
  });
  test('duplicate required records are an error, never double credit', async () => {
    fixture([user], [course(1)], [{ courseId: 1, status: 'completed' }, { courseId: 1, status: 'completed' }]);
    await expect(getComplianceStatus()).rejects.toMatchObject({ statusCode: 409 });
  });
  test.each(['data_manager', 'manager', 'study_director'])('course lists retain legacy and canonical requirements for %s', async role => {
    mockQuery.mockResolvedValue({ rows: [course(1,['manager']), course(2,['data_manager']), course(3,['study_director']), course(4,['monitor'])] });
    expect((await getCourses({ role })).map(row => row.id)).toEqual([1,2,3]);
  });
  test.each([['invented'], ['constructor'], ['__proto__'], [''], [7], 'manager', null].map(roles => ({roles})))('stored malformed roles $roles fail instead of reporting complete compliance', async ({roles}) => {
    fixture([user], [{...course(1),requiredForRoles:roles}], []);
    await expect(getComplianceStatus()).rejects.toMatchObject({ statusCode:409 });
  });
  test.each([['invented'], ['constructor'], ['__proto__'], [7], 'manager', null].map(roles => ({roles})))('course mutations refuse malformed roles $roles before writes', async ({roles}) => {
    await expect(createCourse({ requiredForRoles: roles } as any, 7)).rejects.toMatchObject({ statusCode:400 });
    await expect(updateCourse(1, { requiredForRoles: roles } as any)).rejects.toMatchObject({ statusCode:400 });
    expect(mockQuery).not.toHaveBeenCalled(); expect(mockQueryOne).not.toHaveBeenCalled();
  });

});
