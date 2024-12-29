import express from "express";
import {
  getPendingWithdrawals,
  handleWithdrawal,
} from "../controllers/adminController";
import { verifyAdmin } from "../middlewares/auth";

const router = express.Router();

router.get("/withdrawals", verifyAdmin, getPendingWithdrawals);
router.post("/withdrawals/:transactionId", verifyAdmin, handleWithdrawal);

export { router as adminRouter };

// {
//   "message": "Admin registered successfully",
//   "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJiNGM1MWE4My0yODEyLTRiNjQtODE0YS0wNWYwMDgyOTNiMmQiLCJ1c2VyVHlwZSI6IkFETUlOIiwiaWF0IjoxNzM1NDgyOTIxLCJleHAiOjE3MzYwODc3MjF9.UDMdOUrHWyPnVXm6wfueU_72p4VdJXuwK7TMtaxSsD4",
//   "adminId": "b4c51a83-2812-4b64-814a-05f008293b2d"
// }
