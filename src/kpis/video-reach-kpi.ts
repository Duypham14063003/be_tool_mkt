export const VIDEO_REACH_KPI_TARGET = 300;

const VIDEO_CONTENT_TYPES = new Set(['VIDEO', 'THƯỚC PHIM', 'REEL', 'REELS']);

export type VideoReachKpi = {
  target: number;
  actual: number | null;
  achievementRate: number | null;
  status: 'MET' | 'NOT_MET' | null;
};

export function calculateVideoReachKpi(
  contentType: string,
  reach: bigint | number | null | undefined,
  target = VIDEO_REACH_KPI_TARGET,
): VideoReachKpi {
  const normalizedTarget = target > 0 ? target : VIDEO_REACH_KPI_TARGET;
  const isVideo = VIDEO_CONTENT_TYPES.has(contentType.trim().toLocaleUpperCase('vi-VN'));
  if (!isVideo || reach == null) {
    return {
      target: normalizedTarget,
      actual: null,
      achievementRate: null,
      status: null,
    };
  }

  const actual = Number(reach);
  return {
    target: normalizedTarget,
    actual,
    achievementRate: Math.round((actual / normalizedTarget) * 10000) / 100,
    status: actual >= normalizedTarget ? 'MET' : 'NOT_MET',
  };
}
