import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth";
import { verifyToken } from "./middlewares/auth";
import { userRouter } from "./routes/user";

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// Auth routes
app.use("/api/auth", authRouter);
app.use("/api/users", userRouter);

// Protected routes example
app.get("/api/protected", verifyToken, (req, res) => {
  res.json({ message: "Protected route accessed successfully" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
