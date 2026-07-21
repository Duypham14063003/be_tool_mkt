import { Injectable } from '@nestjs/common';
@Injectable() export class KpiCalculatorService {
  private round(v: number) { return Math.round(v * 100) / 100 }
  facebookEngagement(reactions: number | null, comments: number | null, shares: number | null, reach: number | null) { if (reactions === null || comments === null || shares === null || !reach) return null; return this.round((reactions + comments + shares) / reach * 100) }
  tiktokEngagement(likes: number | null, comments: number | null, shares: number | null, saves: number | null, views: number | null) { if (likes === null || comments === null || shares === null || saves === null || !views) return null; return this.round((likes + comments + shares + saves) / views * 100) }
  achievement(actual: number | null, target: number | null) { if (actual === null || !target) return null; return this.round(actual / target * 100) }
  growth(current: number | null, previous: number | null) { if (current === null || previous === null || previous === 0) return null; return this.round((current - previous) / previous * 100) }
  status(rate: number | null) { if (rate === null) return null; if (rate < 80) return 'NOT_MET'; if (rate < 100) return 'NEAR_TARGET'; if (rate < 120) return 'MET'; return 'EXCEEDED' }
}
