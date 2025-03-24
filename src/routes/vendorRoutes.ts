import express from "express";
import {
  cancelVendorBooking,
  completeVendorRide,
  createDriverCommissionPayment,
  createVendorBooking,
  driverArrived,
  getVendorBookingDetails,
  getVendorBookings,
  getVendorEarnings,
  getVendorFareEstimate,
  getVendorTransactions,
  getVendorWallet,
  startDriverPickup,
  startVendorRide,
  verifyDriverCommissionPayment,
} from "../controllers/vendorController";
import { verifyToken } from "../middlewares/auth";

const router = express.Router();

// Public routes
router.post("/estimate", getVendorFareEstimate);

// Protected routes
router.use(verifyToken);

// Vendor routes
router.get("/wallet", getVendorWallet);
router.get("/transactions", getVendorTransactions);
router.get("/earnings", getVendorEarnings);
router.post("/bookings", createVendorBooking);
router.get("/bookings", getVendorBookings);
router.get("/bookings/:bookingId", getVendorBookingDetails);

// Driver routes
router.post(
  "/bookings/:bookingId/commission/create",
  createDriverCommissionPayment
);
router.post(
  "/bookings/:bookingId/commission/verify",
  verifyDriverCommissionPayment
);
router.post("/bookings/:bookingId/pickup/start", startDriverPickup);
router.post("/bookings/:bookingId/arrived", driverArrived);
router.post("/bookings/:bookingId/start", startVendorRide);
router.post("/bookings/:bookingId/complete", completeVendorRide);
router.post("/bookings/:bookingId/cancel", cancelVendorBooking);

export { router as vendorRouter };
