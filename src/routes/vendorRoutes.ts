import express from "express";
import {
  createVendorAllIndiaBooking,
  getVendorAllIndiaFareEstimate,
} from "../controllers/vendorAllIndiaController";
import {
  cancelVendorBooking,
  completeVendorRide,
  createDriverCommissionPayment,
  createVendorBooking,
  createVendorChardhamBooking,
  driverArrived,
  getVendorBookingDetails,
  getVendorBookings,
  getVendorChardhamFareEstimate,
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
router.post("/chardham/estimate", getVendorChardhamFareEstimate);
router.post("/all-india/estimate", getVendorAllIndiaFareEstimate);

// Protected routes
router.use(verifyToken);

// Vendor routes
router.get("/wallet", getVendorWallet);
router.get("/transactions", getVendorTransactions);
router.get("/earnings", getVendorEarnings);
router.post("/bookings", createVendorBooking);
router.post("/chardham/bookings", createVendorChardhamBooking);
router.post("/all-india/bookings", createVendorAllIndiaBooking);
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
