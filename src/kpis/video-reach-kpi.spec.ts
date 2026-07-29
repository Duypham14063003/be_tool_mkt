import { calculateVideoReachKpi } from './video-reach-kpi';

describe('calculateVideoReachKpi', () => {
  it.each(['VIDEO', 'Thước phim', 'reel', 'REELS'])('recognizes %s as video', (contentType) => {
    expect(calculateVideoReachKpi(contentType, 300n)).toEqual({
      target: 300,
      actual: 300,
      achievementRate: 100,
      status: 'MET',
    });
  });

  it('uses the reach stored for each video', () => {
    expect(calculateVideoReachKpi('Thước phim', 298n)).toEqual({
      target: 300,
      actual: 298,
      achievementRate: 99.33,
      status: 'NOT_MET',
    });
  });

  it('uses the configured per-video target', () => {
    expect(calculateVideoReachKpi('Thước phim', 327n, 350)).toEqual({
      target: 350,
      actual: 327,
      achievementRate: 93.43,
      status: 'NOT_MET',
    });
  });

  it('does not calculate when the post is not a video or reach is unavailable', () => {
    expect(calculateVideoReachKpi('Ảnh', 5460n).status).toBeNull();
    expect(calculateVideoReachKpi('VIDEO', null).status).toBeNull();
  });
});
