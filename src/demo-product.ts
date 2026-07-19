export const demoProduct = {
  id: "vintage-camera",
  name: "Vintage Camera",
  price: "$249.00",
  stockRemaining: 3,
  lowStockThreshold: 5,
} as const;

export const demoVariant = import.meta.env.VITE_DEMO_VARIANT === "legacy" ? "legacy" : "updated";
export const hasLowStockWarning = demoVariant === "updated";
