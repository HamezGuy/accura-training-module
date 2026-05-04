import {
  generateCertificateNumber,
  calculateExpirationDate,
  isCertificateExpired,
} from '../../src/services/certificate.service';

// Mock environment config
jest.mock('../../src/config/environment', () => ({
  config: {
    training: { certificateValidityDays: 365 },
  },
}));

describe('CertificateService', () => {
  describe('generateCertificateNumber', () => {
    it('should generate a unique certificate number', () => {
      const cert1 = generateCertificateNumber('GCP-101', 1);
      const cert2 = generateCertificateNumber('GCP-101', 1);

      expect(cert1).not.toEqual(cert2);
    });

    it('should include course code and user ID in format', () => {
      const cert = generateCertificateNumber('CFR11-101', 42);

      expect(cert).toMatch(/^AT-CERT-CFR11-101-42-/);
    });

    it('should produce uppercase output', () => {
      const cert = generateCertificateNumber('hipaa-101', 5);

      expect(cert).toMatch(/^AT-CERT-HIPAA-101-5-[A-Z0-9]+-[A-Z0-9]+$/);
    });
  });

  describe('calculateExpirationDate', () => {
    it('should default to 365 days when no validity period provided', () => {
      const now = new Date();
      const expiration = calculateExpirationDate(null);

      const diffDays = Math.round(
        (expiration.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(diffDays).toBeGreaterThanOrEqual(364);
      expect(diffDays).toBeLessThanOrEqual(366);
    });

    it('should use provided validity days', () => {
      const now = new Date();
      const expiration = calculateExpirationDate(30);

      const diffDays = Math.round(
        (expiration.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );
      expect(diffDays).toBeGreaterThanOrEqual(29);
      expect(diffDays).toBeLessThanOrEqual(31);
    });
  });

  describe('isCertificateExpired', () => {
    it('should return false when no expiration date', () => {
      expect(isCertificateExpired(null)).toBe(false);
    });

    it('should return false for future date', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      expect(isCertificateExpired(futureDate.toISOString())).toBe(false);
    });

    it('should return true for past date', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      expect(isCertificateExpired(pastDate.toISOString())).toBe(true);
    });

    it('should accept Date objects', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      expect(isCertificateExpired(pastDate)).toBe(true);
    });
  });
});
