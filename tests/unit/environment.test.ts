jest.mock('dotenv', () => ({ config: jest.fn() }));

describe('explicit trusted authentication authority configuration', () => {
  const keys = ['ACCURA_API_URL', 'ACCURA_API_TIMEOUT_MS', 'JWT_SECRET', 'NODE_ENV'] as const;
  let original: Partial<Record<typeof keys[number], string>>;
  beforeEach(() => {
    original = {};
    for (const key of keys) { original[key] = process.env[key]; delete process.env[key]; }
    jest.resetModules();
  });
  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  });
  function load() {
    return require('../../src/config/environment').config as import('../../src/config/environment').EnvironmentConfig;
  }
  test.each(['development', 'test', 'production'])('refuses a missing authority in %s without a signing secret', environment => {
    process.env['NODE_ENV'] = environment;
    expect(load).toThrow('Missing required environment variable: ACCURA_API_URL');
  });
  test.each(['http://api:3000', 'https://native.example.invalid/'])('accepts an explicit root %s without a signing secret', root => {
    process.env['ACCURA_API_URL'] = root;
    const config = load();
    expect(config.authority).toEqual({ baseUrl: new URL(root).origin, timeoutMs: 10000 });
    expect(config).not.toHaveProperty('jwt');
  });
  test.each(['not-a-url', 'ftp://native.invalid', 'http://user:private-marker@native.invalid',
    'http://native.invalid/path', 'http://native.invalid?private-marker', 'http://native.invalid#private-marker',
    'http://native.invalid?', 'http://native.invalid#', ' http://native.invalid', 'http://native.invalid ',
    'http:/native.invalid', 'http://native.invalid/child/..', 'http://nat\nive.invalid', 'http://native.invalid\\']) (
    'refuses unsafe authority %s without repeating its value', root => {
      process.env['ACCURA_API_URL'] = root;
      let failure: unknown;
      try { load(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('ACCURA_API_URL');
      expect((failure as Error).message).not.toContain(root);
      expect((failure as Error).message).not.toContain('private-marker');
    });
  test.each(['', '0', '-1', '1.5', '30001', 'Infinity', '1e3', ' 1000', '9007199254740992'])(
    'refuses an invalid timeout %s', timeout => {
      process.env['ACCURA_API_URL'] = 'http://api:3000';
      process.env['ACCURA_API_TIMEOUT_MS'] = timeout;
      expect(load).toThrow('ACCURA_API_TIMEOUT_MS must be an integer from 1 to 30000 milliseconds.');
    });
  test.each(['1', '30000'])('accepts bounded integer timeout %s', timeout => {
    process.env['ACCURA_API_URL'] = 'http://api:3000';
    process.env['ACCURA_API_TIMEOUT_MS'] = timeout;
    expect(load().authority.timeoutMs).toBe(Number(timeout));
  });
});
