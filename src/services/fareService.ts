import  type { RateType, ServiceType } from "@prisma/client";
import { prisma } from "../lib/prisma";

class FareService {
  private static instance: FareService;
  private rateCache: Map<string, { amount: number; timestamp: number }> =
    new Map();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes

  // Hardcoded fallbacks (your current rates)
  private fallbackRates = {
    LOCAL: {
      mini: { short: 17, long: 14 },
      sedan: { short: 23, long: 17 },
      suv: { short: 35, long: 27 },
    },
    CAR_RENTAL: {
      mini: {
        1: { km: 15, price: 380 },
        2: { km: 25, price: 550 },
        3: { km: 35, price: 700 },
        4: { km: 45, price: 950 },
        5: { km: 60, price: 1250 },
        6: { km: 70, price: 1550 },
        7: { km: 80, price: 1850 },
        8: { km: 90, price: 2100 },
      },
      sedan: {
        1: { km: 15, price: 450 },
        2: { km: 25, price: 600 },
        3: { km: 40, price: 850 },
        4: { km: 50, price: 1100 },
        5: { km: 65, price: 1400 },
        6: { km: 75, price: 1650 },
        7: { km: 85, price: 2000 },
        8: { km: 90, price: 2300 },
      },
      suv: {
        1: { km: 15, price: 580 },
        2: { km: 25, price: 750 },
        3: { km: 40, price: 950 },
        4: { km: 50, price: 1200 },
        5: { km: 65, price: 1500 },
        6: { km: 75, price: 1850 },
        7: { km: 85, price: 2100 },
        8: { km: 90, price: 2450 },
      },
    },
    OUTSTATION: {
      mini: { base: 11, short: 14 },
      sedan: { base: 13, short: 19 },
      ertiga: { base: 18, short: 24 },
      innova: { base: 21, short: 27 },
      tempo_12: { fixed: 16000, extra: 23 },
      tempo_16: { fixed: 18000, extra: 26 },
      tempo_20: { fixed: 20000, extra: 30 },
      tempo_26: { fixed: 22000, extra: 35 },
    },
    HILL_STATION: {
      mini: { base: 15 },
      sedan: { base: 17 },
      ertiga: { base: 22 },
      innova: { base: 28 },
      tempo_12: { fixed: 16000, extra: 23 },
      tempo_16: { fixed: 18000, extra: 26 },
      tempo_20: { fixed: 20000, extra: 30 },
      tempo_26: { fixed: 22000, extra: 35 },
    },
    ALL_INDIA_TOUR: {
      mini: { perDay: 2800, extraKm: 14 },
      sedan: { perDay: 3500, extraKm: 16 },
      ertiga: { perDay: 5200, extraKm: 16 },
      innova: { perDay: 6000, extraKm: 18 },
      tempo_12: { perDay: 8000, extraKm: 20 },
      tempo_16: { perDay: 9000, extraKm: 22 },
      tempo_20: { perDay: 10000, extraKm: 24 },
      tempo_26: { perDay: 11000, extraKm: 26 },
    },
    CHARDHAM_YATRA: {
      mini: { perDay: 2800, perKm: 11 },
      sedan: { perDay: 3500, perKm: 14 },
      ertiga: { perDay: 5200, perKm: 18 },
      innova: { perDay: 6000, perKm: 24 },
      tempo_12: { perDay: 8000, perKm: 23 },
      tempo_16: { perDay: 9000, perKm: 26 },
      tempo_20: { perDay: 10000, perKm: 30 },
      tempo_26: { perDay: 11000, perKm: 35 },
    },
  };

  static getInstance(): FareService {
    if (!FareService.instance) {
      FareService.instance = new FareService();
    }
    return FareService.instance;
  }

  private generateCacheKey(
    serviceType: string,
    vehicleCategory: string,
    rateType: string,
    packageHours?: number
  ): string {
    return `${serviceType}_${vehicleCategory}_${rateType}_${packageHours || "none"}`;
  }

  private isCacheValid(cached: { timestamp: number }): boolean {
    return Date.now() - cached.timestamp < this.cacheTimeout;
  }

  // Main method to get any rate
  async getRate(
    serviceType: ServiceType,
    vehicleCategory: string,
    rateType: RateType,
    packageHours?: number
  ): Promise<number> {
    const cacheKey = this.generateCacheKey(
      serviceType,
      vehicleCategory,
      rateType,
      packageHours
    );
    const cached = this.rateCache.get(cacheKey);

    if (cached && this.isCacheValid(cached)) {
      return cached.amount;
    }

    try {
      const dbRate = await prisma.fareConfiguration.findFirst({
        where: {
          serviceType,
          vehicleCategory,
          rateType,
          ...(packageHours && { packageHours }),
          isActive: true,
        },
      });

      if (dbRate) {
        this.rateCache.set(cacheKey, {
          amount: dbRate.amount,
          timestamp: Date.now(),
        });
        return dbRate.amount;
      }

      // Fallback to hardcoded rates
      return this.getFallbackRate(
        serviceType,
        vehicleCategory,
        rateType,
        packageHours
      );
    } catch (error) {
      console.error("Error fetching rate from database:", error);
      return this.getFallbackRate(
        serviceType,
        vehicleCategory,
        rateType,
        packageHours
      );
    }
  }

  private getFallbackRate(
    serviceType: ServiceType,
    vehicleCategory: string,
    rateType: RateType,
    packageHours?: number
  ): number {
    const serviceRates = this.fallbackRates[serviceType];
    if (!serviceRates) return 0;

    const vehicleRates =
      serviceRates[vehicleCategory as keyof typeof serviceRates];
    if (!vehicleRates) return 0;

    switch (serviceType) {
      case "LOCAL":
        return rateType === "PER_KM_SHORT"
          ? vehicleRates.short
          : vehicleRates.long;
      case "CAR_RENTAL":
        if (packageHours && rateType === "PACKAGE_PRICE") {
          return vehicleRates[packageHours]?.price || 0;
        }
        if (packageHours && rateType === "PACKAGE_KM") {
          return vehicleRates[packageHours]?.km || 0;
        }
        return 0;
        case "OUTSTATION":
            
      case "HILL_STATION":
        if (vehicleCategory.startsWith("tempo_")) {
          return rateType === "FIXED_RATE"
            ? vehicleRates.fixed
            : vehicleRates.extra;
        }
        return rateType === "BASE_RATE"
          ? vehicleRates.base
          : vehicleRates.short;
      case "ALL_INDIA_TOUR":
        return rateType === "PER_DAY"
          ? vehicleRates.perDay
          : vehicleRates.extraKm;
      case "CHARDHAM_YATRA":
        return rateType === "PER_DAY"
          ? vehicleRates.perDay
          : vehicleRates.perKm;
      default:
        return 0;
    }
  }

  // Get all rates for a service (for admin display)
  async getServiceRates(serviceType: ServiceType): Promise<any> {
    try {
      const rates = await prisma.fareConfiguration.findMany({
        where: {
          serviceType,
          isActive: true,
        },
        orderBy: [
          { vehicleCategory: "asc" },
          { rateType: "asc" },
          { packageHours: "asc" },
        ],
      });

      return rates;
    } catch (error) {
      console.error("Error fetching service rates:", error);
      return [];
    }
  }

  // Get last edit info for a service
  async getServiceLastEdit(
    serviceType: ServiceType
  ): Promise<{ lastEditedAt: Date | null; lastEditedBy: string | null }> {
    try {
      const lastEdit = await prisma.fareConfiguration.findFirst({
        where: {
          serviceType,
          isActive: true,
          lastEditedAt: { not: null },
        },
        orderBy: { lastEditedAt: "desc" },
        select: { lastEditedAt: true, lastEditedBy: true },
      });

      return {
        lastEditedAt: lastEdit?.lastEditedAt || null,
        lastEditedBy: lastEdit?.lastEditedBy || null,
      };
    } catch (error) {
      console.error("Error fetching last edit info:", error);
      return { lastEditedAt: null, lastEditedBy: null };
    }
  }

  // Clear cache when admin updates rates
  clearCache(): void {
    this.rateCache.clear();
  }
}

export const fareService = FareService.getInstance();
