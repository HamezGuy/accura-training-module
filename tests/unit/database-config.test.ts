import { Client } from 'pg';

describe('verified training PostgreSQL configuration', () => {
  const base = { host: 'native-db.invalid', port: 5432, name: 'owned', user: 'owned', password: 'fixture-only', ssl: true };
  let makePool: jest.Mock;
  beforeEach(() => {
    jest.resetModules();
    makePool = jest.fn(() => ({ on: jest.fn() }));
    jest.doMock('pg', () => ({ Pool: makePool }));
    jest.doMock('../../src/config/logger', () => ({ logger: { error: jest.fn() } }));
  });
  function load(database: Record<string, unknown>) {
    jest.doMock('../../src/config/environment', () => ({ config: { database } }));
    require('../../src/config/database');
    return makePool.mock.calls[0][0];
  }
  function nativeSsl(options: Record<string, unknown>) {
    // The real installed pg parser is used without connecting to any server.
    return (new Client(options) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
  }
  test.each([undefined, 'postgresql://owned:fixture-only@native-db.invalid/owned',
    'postgresql://owned:fixture-only@native-db.invalid/owned?sslmode=verify-full',
    'postgresql://owned:fixture-only@native-db.invalid/owned?ssl=true'])(
    'keeps certificate verification enabled for %s', url => {
      const options = load({ ...base, url });
      const ssl = nativeSsl(options);
      expect(ssl).not.toBe(false);
      expect(ssl).not.toEqual(expect.objectContaining({ rejectUnauthorized: false }));
      expect(options.ssl).toEqual({ rejectUnauthorized: true });
    });
  test.each(['ssl=false', 'ssl=no-verify', 'sslmode=disable', 'sslmode=no-verify',
    'sslmode=require', 'uselibpqcompat=true&sslmode=require', 'uselibpqcompat=true&sslmode=verify-full',
    'sslmode=verify-full&sslmode=no-verify', 'ssl=true&ssl=false'])(
    'rejects connection-string TLS override %s before constructing a pool', parameters => {
      expect(() => load({ ...base, url: `postgresql://owned:fixture-only@native-db.invalid/owned?${parameters}` })).toThrow('DATABASE_SSL requires verified TLS');
      expect(makePool).not.toHaveBeenCalled();
    });
  test('preserves an explicitly local non-TLS connection', () => {
    const options = load({ ...base, ssl: false }); expect(nativeSsl(options)).toBe(false);
  });
});
