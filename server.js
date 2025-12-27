import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB Connection (with fallback to in-memory for easy deployment)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/inventory_db';
let useInMemory = false;

try {
  if (process.env.NODE_ENV !== 'production' || MONGODB_URI.includes('localhost')) {
    console.log('Note: Using MongoDB. For cloud deployment, consider MongoDB Atlas or in-memory mode.');
  }

  mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => {
      console.log('MongoDB connection failed, using in-memory storage:', err.message);
      useInMemory = true;
    });
} catch (error) {
  console.log('Using in-memory storage mode');
  useInMemory = true;
}

// In-memory storage fallback
let inMemoryProducts = [];
let inMemoryTransactions = [];
let productIdCounter = 1;
let transactionIdCounter = 1;

// Models
const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  sku: { type: String, required: true, unique: true },
  category: { type: String, required: true },
  quantity: { type: Number, required: true, default: 0 },
  reorderPoint: { type: Number, required: true, default: 10 },
  unitPrice: { type: Number, required: true },
  location: { type: String, default: 'Main Warehouse' },
  supplier: { type: String, default: '' },
  lastRestocked: { type: Date, default: Date.now },
  status: {
    type: String,
    enum: ['In Stock', 'Low Stock', 'Out of Stock', 'Damaged'],
    default: 'In Stock'
  }
}, { timestamps: true });

const transactionSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  type: { type: String, enum: ['IN', 'OUT', 'DAMAGE', 'RETURN'], required: true },
  quantity: { type: Number, required: true },
  notes: { type: String, default: '' },
  performedBy: { type: String, default: 'System' },
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// Helper function to update product status
const updateProductStatus = (product) => {
  if (product.quantity === 0) {
    product.status = 'Out of Stock';
  } else if (product.quantity <= product.reorderPoint) {
    product.status = 'Low Stock';
  } else {
    product.status = 'In Stock';
  }
};

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Server is running',
    storageMode: useInMemory ? 'in-memory' : 'mongodb'
  });
});

// Get all products
app.get('/api/products', async (req, res) => {
  try {
    if (useInMemory) {
      res.json(inMemoryProducts);
    } else {
      const products = await Product.find().sort({ createdAt: -1 });
      res.json(products);
    }
  } catch (error) {
    res.status(500).json({ message: 'Error fetching products', error: error.message });
  }
});

// Get single product
app.get('/api/products/:id', async (req, res) => {
  try {
    if (useInMemory) {
      const product = inMemoryProducts.find(p => p._id === req.params.id);
      if (!product) {
        return res.status(404).json({ message: 'Product not found' });
      }
      res.json(product);
    } else {
      const product = await Product.findById(req.params.id);
      if (!product) {
        return res.status(404).json({ message: 'Product not found' });
      }
      res.json(product);
    }
  } catch (error) {
    res.status(500).json({ message: 'Error fetching product', error: error.message });
  }
});

// Create product
app.post('/api/products', async (req, res) => {
  try {
    if (useInMemory) {
      const newProduct = {
        _id: String(productIdCounter++),
        ...req.body,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      updateProductStatus(newProduct);
      inMemoryProducts.push(newProduct);
      res.status(201).json(newProduct);
    } else {
      const product = new Product(req.body);
      updateProductStatus(product);
      await product.save();
      res.status(201).json(product);
    }
  } catch (error) {
    res.status(400).json({ message: 'Error creating product', error: error.message });
  }
});

// Update product
app.put('/api/products/:id', async (req, res) => {
  try {
    if (useInMemory) {
      const index = inMemoryProducts.findIndex(p => p._id === req.params.id);
      if (index === -1) {
        return res.status(404).json({ message: 'Product not found' });
      }
      const updatedProduct = {
        ...inMemoryProducts[index],
        ...req.body,
        updatedAt: new Date()
      };
      updateProductStatus(updatedProduct);
      inMemoryProducts[index] = updatedProduct;
      res.json(updatedProduct);
    } else {
      const product = await Product.findByIdAndUpdate(
        req.params.id,
        req.body,
        { new: true, runValidators: true }
      );
      if (!product) {
        return res.status(404).json({ message: 'Product not found' });
      }
      updateProductStatus(product);
      await product.save();
      res.json(product);
    }
  } catch (error) {
    res.status(400).json({ message: 'Error updating product', error: error.message });
  }
});

// Delete product
app.delete('/api/products/:id', async (req, res) => {
  try {
    if (useInMemory) {
      const index = inMemoryProducts.findIndex(p => p._id === req.params.id);
      if (index === -1) {
        return res.status(404).json({ message: 'Product not found' });
      }
      inMemoryProducts.splice(index, 1);
      res.json({ message: 'Product deleted successfully' });
    } else {
      const product = await Product.findByIdAndDelete(req.params.id);
      if (!product) {
        return res.status(404).json({ message: 'Product not found' });
      }
      res.json({ message: 'Product deleted successfully' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error deleting product', error: error.message });
  }
});

// Create transaction (stock movement)
app.post('/api/transactions', async (req, res) => {
  try {
    const { productId, type, quantity, notes, performedBy } = req.body;

    if (useInMemory) {
      const product = inMemoryProducts.find(p => p._id === productId);
      if (!product) {
        return res.status(404).json({ message: 'Product not found' });
      }

      // Update quantity based on transaction type
      if (type === 'IN' || type === 'RETURN') {
        product.quantity += quantity;
      } else if (type === 'OUT' || type === 'DAMAGE') {
        product.quantity -= quantity;
      }

      if (type === 'IN') {
        product.lastRestocked = new Date();
      }

      updateProductStatus(product);
      product.updatedAt = new Date();

      const transaction = {
        _id: String(transactionIdCounter++),
        productId,
        type,
        quantity,
        notes: notes || '',
        performedBy: performedBy || 'System',
        createdAt: new Date()
      };

      inMemoryTransactions.push(transaction);
      res.status(201).json({ transaction, product });
    } else {
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({ message: 'Product not found' });
      }

      // Update quantity based on transaction type
      if (type === 'IN' || type === 'RETURN') {
        product.quantity += quantity;
      } else if (type === 'OUT' || type === 'DAMAGE') {
        product.quantity -= quantity;
      }

      if (type === 'IN') {
        product.lastRestocked = new Date();
      }

      updateProductStatus(product);
      await product.save();

      const transaction = new Transaction({ productId, type, quantity, notes, performedBy });
      await transaction.save();

      res.status(201).json({ transaction, product });
    }
  } catch (error) {
    res.status(400).json({ message: 'Error creating transaction', error: error.message });
  }
});

// Get transactions
app.get('/api/transactions', async (req, res) => {
  try {
    if (useInMemory) {
      res.json(inMemoryTransactions);
    } else {
      const transactions = await Transaction.find()
        .populate('productId')
        .sort({ createdAt: -1 })
        .limit(100);
      res.json(transactions);
    }
  } catch (error) {
    res.status(500).json({ message: 'Error fetching transactions', error: error.message });
  }
});

// Get analytics/dashboard data
app.get('/api/analytics', async (req, res) => {
  try {
    let products;
    if (useInMemory) {
      products = inMemoryProducts;
    } else {
      products = await Product.find();
    }

    const totalProducts = products.length;
    const totalValue = products.reduce((sum, p) => sum + (p.quantity * p.unitPrice), 0);
    const lowStockItems = products.filter(p => p.status === 'Low Stock' || p.status === 'Out of Stock');
    const damagedItems = products.filter(p => p.status === 'Damaged');

    // Category breakdown
    const categoryBreakdown = products.reduce((acc, p) => {
      acc[p.category] = (acc[p.category] || 0) + 1;
      return acc;
    }, {});

    // Top value products
    const topProducts = [...products]
      .sort((a, b) => (b.quantity * b.unitPrice) - (a.quantity * a.unitPrice))
      .slice(0, 5);

    res.json({
      totalProducts,
      totalValue,
      lowStockCount: lowStockItems.length,
      damagedCount: damagedItems.length,
      categoryBreakdown,
      topProducts,
      lowStockItems: lowStockItems.slice(0, 10),
      alerts: lowStockItems.map(p => ({
        productId: p._id,
        productName: p.name,
        currentStock: p.quantity,
        reorderPoint: p.reorderPoint,
        severity: p.status === 'Out of Stock' ? 'critical' : 'warning'
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching analytics', error: error.message });
  }
});

// Seed data endpoint (for demo purposes)
app.post('/api/seed', async (req, res) => {
  try {
    const sampleProducts = [
      { name: 'Steel Rods (10mm)', sku: 'SR-10MM-001', category: 'Steel', quantity: 150, reorderPoint: 50, unitPrice: 450, location: 'Warehouse A', supplier: 'Steel Corp India' },
      { name: 'Cement Bags (50kg)', sku: 'CM-50KG-001', category: 'Cement', quantity: 200, reorderPoint: 100, unitPrice: 380, location: 'Warehouse B', supplier: 'UltraTech' },
      { name: 'Bricks (Red Clay)', sku: 'BR-RC-001', category: 'Bricks', quantity: 5000, reorderPoint: 1000, unitPrice: 8, location: 'Yard 1', supplier: 'Local Kiln' },
      { name: 'Sand (per ton)', sku: 'SD-T-001', category: 'Aggregates', quantity: 25, reorderPoint: 10, unitPrice: 1200, location: 'Yard 2', supplier: 'Sand Suppliers Ltd' },
      { name: 'Paint (White 20L)', sku: 'PT-W20-001', category: 'Paint', quantity: 8, reorderPoint: 15, unitPrice: 2500, location: 'Warehouse A', supplier: 'Asian Paints' },
      { name: 'Tiles (Ceramic 2x2)', sku: 'TL-C22-001', category: 'Tiles', quantity: 3, reorderPoint: 20, unitPrice: 450, location: 'Warehouse C', supplier: 'Kajaria' },
      { name: 'Plywood (8mm)', sku: 'PW-8MM-001', category: 'Wood', quantity: 45, reorderPoint: 20, unitPrice: 1800, location: 'Warehouse A', supplier: 'Century Ply' },
    ];

    if (useInMemory) {
      inMemoryProducts = sampleProducts.map((p, i) => ({
        _id: String(i + 1),
        ...p,
        status: p.quantity <= p.reorderPoint ? 'Low Stock' : 'In Stock',
        lastRestocked: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }));
      productIdCounter = inMemoryProducts.length + 1;
      res.json({ message: 'Sample data created successfully', count: inMemoryProducts.length });
    } else {
      await Product.deleteMany({});
      const products = await Product.insertMany(sampleProducts.map(p => {
        const product = new Product(p);
        updateProductStatus(product);
        return product;
      }));
      res.json({ message: 'Sample data created successfully', count: products.length });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error seeding data', error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Storage mode: ${useInMemory ? 'in-memory' : 'MongoDB'}`);
  console.log(`API available at: http://localhost:${PORT}/api`);
});
