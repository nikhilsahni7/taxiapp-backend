import { RateType, ServiceType } from "@prisma/client";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { fareService } from "../services/fareService";

// Get all rates for a specific service type
export const getServiceRates = async (req: Request, res: Response) => {
  const { serviceType } = req.params;

  if (!req.user || req.user.userType !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }

  try {
    const rates = await fareService.getServiceRates(serviceType as ServiceType);
    const lastEdit = await fareService.getServiceLastEdit(
      serviceType as ServiceType
    );

    res.json({
      serviceType,
      rates,
      lastEditInfo: lastEdit,
    });
  } catch (error) {
    console.error("Error fetching service rates:", error);
    res.status(500).json({ error: "Failed to fetch service rates" });
  }
};

// Update multiple rates for a service
export const updateServiceRates = async (req: Request, res: Response) => {
  const { serviceType } = req.params;
  const { rates } = req.body; // Array of rate updates

  if (!req.user || req.user.userType !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }

  if (!Array.isArray(rates)) {
    return res.status(400).json({ error: "Rates must be an array" });
  }

  try {
    const updatedRates = [];
    const changesCount = rates.length;
    const changesSummary = [];

    // Update each rate and collect change information
    for (const rateUpdate of rates) {
      const { vehicleCategory, rateType, amount, packageHours } = rateUpdate;

      if (!vehicleCategory || !rateType || amount === undefined) {
        continue; // Skip invalid entries
      }

      // Properly handle packageHours - convert undefined to null explicitly
      const normalizedPackageHours =
        packageHours !== undefined ? packageHours : null;

      // First try to find existing rate to capture old value
      const existingRate = await prisma.fareConfiguration.findFirst({
        where: {
          serviceType: serviceType as ServiceType,
          vehicleCategory: vehicleCategory.toLowerCase(),
          rateType: rateType as RateType,
          packageHours: normalizedPackageHours,
          isActive: true,
        },
      });

      // Capture the old amount for edit history
      const oldAmount = existingRate ? existingRate.amount : null;

      let updatedRate;
      if (existingRate) {
        // Update existing rate
        updatedRate = await prisma.fareConfiguration.update({
          where: { id: existingRate.id },
          data: {
            amount,
            lastEditedBy: req.user.userId,
            lastEditedAt: new Date(),
            isActive: true,
          },
        });
      } else {
        // Create new rate
        updatedRate = await prisma.fareConfiguration.create({
          data: {
            serviceType: serviceType as ServiceType,
            vehicleCategory: vehicleCategory.toLowerCase(),
            rateType: rateType as RateType,
            packageHours: normalizedPackageHours,
            amount,
            lastEditedBy: req.user.userId,
            lastEditedAt: new Date(),
          },
        });
      }

      // Add change information to summary
      changesSummary.push({
        vehicleCategory: vehicleCategory,
        rateType: rateType,
        oldAmount: oldAmount,
        newAmount: amount,
        packageHours: packageHours,
        action: existingRate ? "updated" : "created",
      });

      updatedRates.push(updatedRate);
    }

    // Create edit log entry with actual old values
    const editLog = await prisma.serviceEditLog.create({
      data: {
        serviceType: serviceType as ServiceType,
        editedBy: req.user.userId,
        changesCount: changesSummary.length,
        editSummary: {
          changes: changesSummary,
        },
      },
    });

    // Clear cache to ensure new rates are used
    fareService.clearCache();

    res.json({
      success: true,
      message: `Updated ${updatedRates.length} rates for ${serviceType}`,
      updatedRates,
      editLogId: editLog.id,
      changesSummary, // Include the detailed changes in response
    });
  } catch (error) {
    console.error("Error updating service rates:", error);
    res.status(500).json({ error: "Failed to update service rates" });
  }
};

// Get all service types with their last edit info
export const getAllServicesOverview = async (req: Request, res: Response) => {
  if (!req.user || req.user.userType !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }

  try {
    const services = [
      "LOCAL",
      "CAR_RENTAL",
      "OUTSTATION",
      "HILL_STATION",
      "ALL_INDIA_TOUR",
      "CHARDHAM_YATRA",
    ];
    const overview = [];

    for (const service of services) {
      const lastEdit = await fareService.getServiceLastEdit(
        service as ServiceType
      );
      const ratesCount = await prisma.fareConfiguration.count({
        where: {
          serviceType: service as ServiceType,
          isActive: true,
        },
      });

      overview.push({
        serviceType: service,
        activeRatesCount: ratesCount,
        lastEditedAt: lastEdit.lastEditedAt,
        lastEditedBy: lastEdit.lastEditedBy,
      });
    }

    res.json({ services: overview });
  } catch (error) {
    console.error("Error fetching services overview:", error);
    res.status(500).json({ error: "Failed to fetch services overview" });
  }
};

// Get edit history for a service
export const getServiceEditHistory = async (req: Request, res: Response) => {
  const { serviceType } = req.params;
  const { limit = 20, offset = 0 } = req.query;

  if (!req.user || req.user.userType !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }

  try {
    const editHistory = await prisma.serviceEditLog.findMany({
      where: {
        serviceType: serviceType as ServiceType,
      },
      orderBy: { editedAt: "desc" },
      take: Number(limit),
      skip: Number(offset),
    });

    const totalCount = await prisma.serviceEditLog.count({
      where: {
        serviceType: serviceType as ServiceType,
      },
    });

    res.json({
      serviceType,
      editHistory,
      pagination: {
        total: totalCount,
        limit: Number(limit),
        offset: Number(offset),
        hasMore: totalCount > Number(offset) + Number(limit),
      },
    });
  } catch (error) {
    console.error("Error fetching edit history:", error);
    res.status(500).json({ error: "Failed to fetch edit history" });
  }
};

// Initialize default rates for a service (one-time setup)
export const initializeServiceRates = async (req: Request, res: Response) => {
  const { serviceType } = req.params;

  if (!req.user || req.user.userType !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }

  try {
    // This would populate the database with default rates
    // You can customize this based on your current hardcoded rates
    const defaultRates = getDefaultRatesForService(serviceType as ServiceType);

    if (!defaultRates.length) {
      return res
        .status(400)
        .json({ error: "No default rates defined for this service" });
    }

    const createdRates = [];

    for (const rate of defaultRates) {
      // Ensure packageHours is properly handled
      const rateData = {
        ...rate,
        packageHours:
          rate.packageHours !== undefined ? rate.packageHours : null,
        serviceType: serviceType as ServiceType,
        lastEditedBy: req.user.userId,
        lastEditedAt: new Date(),
      };

      const createdRate = await prisma.fareConfiguration.create({
        data: rateData,
      });
      createdRates.push(createdRate);
    }

    res.json({
      success: true,
      message: `Initialized ${createdRates.length} default rates for ${serviceType}`,
      createdRates,
    });
  } catch (error) {
    console.error("Error initializing service rates:", error);
    res.status(500).json({ error: "Failed to initialize service rates" });
  }
};

// Helper function to get default rates for each service
function getDefaultRatesForService(serviceType: ServiceType): any[] {
  const defaults: Record<ServiceType, any[]> = {
    LOCAL: [
      { vehicleCategory: "mini", rateType: "PER_KM_SHORT", amount: 17 },
      { vehicleCategory: "mini", rateType: "PER_KM_LONG", amount: 14 },
      { vehicleCategory: "sedan", rateType: "PER_KM_SHORT", amount: 23 },
      { vehicleCategory: "sedan", rateType: "PER_KM_LONG", amount: 17 },
      { vehicleCategory: "suv", rateType: "PER_KM_SHORT", amount: 35 },
      { vehicleCategory: "suv", rateType: "PER_KM_LONG", amount: 27 },
    ],
    CAR_RENTAL: [
      // Mini packages - All hours (1-8)
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 1,
        amount: 380,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_KM",
        packageHours: 1,
        amount: 15,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 2,
        amount: 550,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_KM",
        packageHours: 2,
        amount: 25,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 3,
        amount: 700,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_KM",
        packageHours: 3,
        amount: 35,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 4,
        amount: 950,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_KM",
        packageHours: 4,
        amount: 45,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 5,
        amount: 1250,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_KM",
        packageHours: 5,
        amount: 60,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 6,
        amount: 1550,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_KM",
        packageHours: 6,
        amount: 70,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 7,
        amount: 1850,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_KM",
        packageHours: 7,
        amount: 80,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_PRICE",
        packageHours: 8,
        amount: 2100,
      },
      {
        vehicleCategory: "mini",
        rateType: "PACKAGE_KM",
        packageHours: 8,
        amount: 90,
      },

      // Sedan packages - All hours (1-8)
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 1,
        amount: 450,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_KM",
        packageHours: 1,
        amount: 15,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 2,
        amount: 600,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_KM",
        packageHours: 2,
        amount: 25,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 3,
        amount: 850,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_KM",
        packageHours: 3,
        amount: 40,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 4,
        amount: 1100,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_KM",
        packageHours: 4,
        amount: 50,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 5,
        amount: 1400,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_KM",
        packageHours: 5,
        amount: 65,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 6,
        amount: 1650,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_KM",
        packageHours: 6,
        amount: 75,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 7,
        amount: 2000,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_KM",
        packageHours: 7,
        amount: 85,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_PRICE",
        packageHours: 8,
        amount: 2300,
      },
      {
        vehicleCategory: "sedan",
        rateType: "PACKAGE_KM",
        packageHours: 8,
        amount: 90,
      },

      // SUV packages - All hours (1-8)
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 1,
        amount: 580,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_KM",
        packageHours: 1,
        amount: 15,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 2,
        amount: 750,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_KM",
        packageHours: 2,
        amount: 25,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 3,
        amount: 950,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_KM",
        packageHours: 3,
        amount: 40,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 4,
        amount: 1200,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_KM",
        packageHours: 4,
        amount: 50,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 5,
        amount: 1500,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_KM",
        packageHours: 5,
        amount: 65,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 6,
        amount: 1850,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_KM",
        packageHours: 6,
        amount: 75,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 7,
        amount: 2100,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_KM",
        packageHours: 7,
        amount: 85,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_PRICE",
        packageHours: 8,
        amount: 2450,
      },
      {
        vehicleCategory: "suv",
        rateType: "PACKAGE_KM",
        packageHours: 8,
        amount: 90,
      },

      // Extra KM rates for all categories
      { vehicleCategory: "mini", rateType: "EXTRA_KM", amount: 14 },
      { vehicleCategory: "sedan", rateType: "EXTRA_KM", amount: 16 },
      { vehicleCategory: "suv", rateType: "EXTRA_KM", amount: 18 },
    ],
    OUTSTATION: [
      { vehicleCategory: "mini", rateType: "BASE_RATE", amount: 11 },
      { vehicleCategory: "mini", rateType: "SHORT_RATE", amount: 14 },
      { vehicleCategory: "sedan", rateType: "BASE_RATE", amount: 13 },
      { vehicleCategory: "sedan", rateType: "SHORT_RATE", amount: 19 },
      { vehicleCategory: "ertiga", rateType: "BASE_RATE", amount: 18 },
      { vehicleCategory: "ertiga", rateType: "SHORT_RATE", amount: 24 },
      { vehicleCategory: "innova", rateType: "BASE_RATE", amount: 21 },
      { vehicleCategory: "innova", rateType: "SHORT_RATE", amount: 27 },
      { vehicleCategory: "tempo_12", rateType: "FIXED_RATE", amount: 16000 },
      { vehicleCategory: "tempo_12", rateType: "EXTRA_KM", amount: 23 },
      { vehicleCategory: "tempo_16", rateType: "FIXED_RATE", amount: 18000 },
      { vehicleCategory: "tempo_16", rateType: "EXTRA_KM", amount: 26 },
      { vehicleCategory: "tempo_20", rateType: "FIXED_RATE", amount: 20000 },
      { vehicleCategory: "tempo_20", rateType: "EXTRA_KM", amount: 30 },
      { vehicleCategory: "tempo_26", rateType: "FIXED_RATE", amount: 22000 },
      { vehicleCategory: "tempo_26", rateType: "EXTRA_KM", amount: 35 },
    ],
    HILL_STATION: [
      { vehicleCategory: "mini", rateType: "BASE_RATE", amount: 15 },
      { vehicleCategory: "sedan", rateType: "BASE_RATE", amount: 17 },
      { vehicleCategory: "ertiga", rateType: "BASE_RATE", amount: 22 },
      { vehicleCategory: "innova", rateType: "BASE_RATE", amount: 28 },
      { vehicleCategory: "tempo_12", rateType: "FIXED_RATE", amount: 16000 },
      { vehicleCategory: "tempo_12", rateType: "EXTRA_KM", amount: 23 },
      { vehicleCategory: "tempo_16", rateType: "FIXED_RATE", amount: 18000 },
      { vehicleCategory: "tempo_16", rateType: "EXTRA_KM", amount: 26 },
      { vehicleCategory: "tempo_20", rateType: "FIXED_RATE", amount: 20000 },
      { vehicleCategory: "tempo_20", rateType: "EXTRA_KM", amount: 30 },
      { vehicleCategory: "tempo_26", rateType: "FIXED_RATE", amount: 22000 },
      { vehicleCategory: "tempo_26", rateType: "EXTRA_KM", amount: 35 },
    ],
    ALL_INDIA_TOUR: [
      { vehicleCategory: "mini", rateType: "PER_DAY", amount: 2800 },
      { vehicleCategory: "mini", rateType: "EXTRA_KM", amount: 14 },
      { vehicleCategory: "sedan", rateType: "PER_DAY", amount: 3500 },
      { vehicleCategory: "sedan", rateType: "EXTRA_KM", amount: 16 },
      { vehicleCategory: "ertiga", rateType: "PER_DAY", amount: 5200 },
      { vehicleCategory: "ertiga", rateType: "EXTRA_KM", amount: 16 },
      { vehicleCategory: "innova", rateType: "PER_DAY", amount: 6000 },
      { vehicleCategory: "innova", rateType: "EXTRA_KM", amount: 18 },
      { vehicleCategory: "tempo_12", rateType: "PER_DAY", amount: 8000 },
      { vehicleCategory: "tempo_12", rateType: "EXTRA_KM", amount: 20 },
      { vehicleCategory: "tempo_16", rateType: "PER_DAY", amount: 9000 },
      { vehicleCategory: "tempo_16", rateType: "EXTRA_KM", amount: 22 },
      { vehicleCategory: "tempo_20", rateType: "PER_DAY", amount: 10000 },
      { vehicleCategory: "tempo_20", rateType: "EXTRA_KM", amount: 24 },
      { vehicleCategory: "tempo_26", rateType: "PER_DAY", amount: 11000 },
      { vehicleCategory: "tempo_26", rateType: "EXTRA_KM", amount: 26 },
    ],
    CHARDHAM_YATRA: [
      { vehicleCategory: "mini", rateType: "PER_DAY", amount: 2800 },
      { vehicleCategory: "mini", rateType: "EXTRA_KM", amount: 11 },
      { vehicleCategory: "sedan", rateType: "PER_DAY", amount: 3500 },
      { vehicleCategory: "sedan", rateType: "EXTRA_KM", amount: 14 },
      { vehicleCategory: "ertiga", rateType: "PER_DAY", amount: 5200 },
      { vehicleCategory: "ertiga", rateType: "EXTRA_KM", amount: 18 },
      { vehicleCategory: "innova", rateType: "PER_DAY", amount: 6000 },
      { vehicleCategory: "innova", rateType: "EXTRA_KM", amount: 24 },
      { vehicleCategory: "tempo_12", rateType: "PER_DAY", amount: 8000 },
      { vehicleCategory: "tempo_12", rateType: "EXTRA_KM", amount: 23 },
      { vehicleCategory: "tempo_16", rateType: "PER_DAY", amount: 9000 },
      { vehicleCategory: "tempo_16", rateType: "EXTRA_KM", amount: 26 },
      { vehicleCategory: "tempo_20", rateType: "PER_DAY", amount: 10000 },
      { vehicleCategory: "tempo_20", rateType: "EXTRA_KM", amount: 30 },
      { vehicleCategory: "tempo_26", rateType: "PER_DAY", amount: 11000 },
      { vehicleCategory: "tempo_26", rateType: "EXTRA_KM", amount: 35 },
    ],
  };

  return defaults[serviceType] || [];
}
