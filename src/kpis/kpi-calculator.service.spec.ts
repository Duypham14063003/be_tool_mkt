import { KpiCalculatorService } from './kpi-calculator.service';
describe('KpiCalculatorService', () => {
  const s = new KpiCalculatorService();
  it('calculates and rounds Facebook engagement', () =>
    expect(s.facebookEngagement(10, 5, 5, 80)).toBe(25));
  it('calculates TikTok engagement', () => expect(s.tiktokEngagement(10, 5, 3, 2, 100)).toBe(20));
  it('keeps null and zero denominator null', () => {
    expect(s.facebookEngagement(null, 1, 1, 10)).toBeNull();
    expect(s.growth(10, 0)).toBeNull();
  });
  it('calculates growth and status', () => {
    expect(s.growth(120, 100)).toBe(20);
    expect(s.status(120)).toBe('EXCEEDED');
  });
});
