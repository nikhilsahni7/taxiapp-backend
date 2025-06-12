import type { RequestHandler } from "express";
import { Router } from "express";
import {
  getAllServicesOverview,
  getServiceEditHistory,
  getServiceRates,
  initializeServiceRates,
  updateServiceRates,
} from "../controllers/adminFareController";
import { verifyToken } from "../middlewares/auth";

const router = Router();

// Apply authentication to all routes
router.use(verifyToken);

// Get overview of all services
router.get("/overview", getAllServicesOverview as RequestHandler);

// Get rates for a specific service
router.get("/:serviceType/rates", getServiceRates as RequestHandler);

// Update rates for a specific service
router.put("/:serviceType/rates", updateServiceRates as RequestHandler);

// Get edit history for a specific service
router.get("/:serviceType/history", getServiceEditHistory as RequestHandler);

// Initialize default rates for a service (one-time setup)
router.post(
  "/:serviceType/initialize",
  initializeServiceRates as RequestHandler
);

export { router as adminFareRoutes };
