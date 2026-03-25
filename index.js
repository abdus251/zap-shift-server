require('dotenv').config()
const express = require('express')
const cors = require('cors')
const jwt = require('jsonwebtoken')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const admin = require('firebase-admin')

if (!process.env.PAYMENT_GATEWAY_KEY) {
  throw new Error('❌ Stripe key missing')
}

const stripe = require('stripe')(process.env.PAYMENT_GATEWAY_KEY)

const app = express()
const port = process.env.PORT || 5000

app.use(cors())
app.use(express.json())

// ---------------- JWT ----------------
app.post('/jwt', (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).send({ message: 'Email required' })

  const token = jwt.sign({ email }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  })

  res.send({ token })
})

// ---------------- FIREBASE ----------------
try {
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FB_SERVICE_KEY_BASE64, 'base64').toString('utf8'),
  )

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  })

  console.log('✅ Firebase Admin initialized')
} catch (err) {
  console.error('❌ Firebase init failed:', err)
}

// ---------------- DB ----------------
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.u8om2pp.mongodb.net/?appName=Cluster0`

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})

async function run() {
  try {
    await client.connect()
    console.log('✅ MongoDB connected')

    const db = client.db('parcelDB')

    const userCollection = db.collection('users')
    const parcelsCollection = db.collection('parcels')
    const trackingCollection = db.collection('tracking')
    const paymentCollection = db.collection('payments')
    const ridersCollection = db.collection('riders')

    // ---------------- HELPER ----------------
    async function updateParcelStatus(id, status, extraFields = {}) {
      if (!ObjectId.isValid(id)) throw new Error('Invalid ID')

      return await parcelsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            deliveryStatus: status,
            ...extraFields,
          },
          $push: {
            history: {
              status,
              timestamp: new Date(),
            },
          },
        },
      )
    }

    // ---------------- MIDDLEWARE ----------------
    const verifyFBToken = async (req, res, next) => {
      const authHeader = req.headers.authorization
      if (!authHeader) return res.status(401).send({ message: 'Unauthorized' })

      const token = authHeader.split(' ')[1]

      try {
        const decoded = await admin.auth().verifyIdToken(token)
        req.decoded = decoded
        next()
      } catch {
        res.status(401).send({ message: 'Unauthorized' })
      }
    }

    const verifyAdmin = async (req, res, next) => {
      const user = await userCollection.findOne({
        email: req.decoded.email,
      })
      if (!user || user.role !== 'admin')
        return res.status(403).send({ message: 'Forbidden' })
      next()
    }

    const verifyRider = async (req, res, next) => {
      const user = await userCollection.findOne({
        email: req.decoded.email,
      })
      if (!user || user.role !== 'rider')
        return res.status(403).send({ message: 'Forbidden' })
      next()
    }

    // ---------------- ROUTES ----------------

    // USERS
    app.post('/users', async (req, res) => {
      const email = req.body.email
      const exists = await userCollection.findOne({ email })

      if (exists) {
        await userCollection.updateOne(
          { email },
          { $set: { lastLogin: new Date() } },
        )
        return res.send({ inserted: false })
      }

      const result = await userCollection.insertOne(req.body)
      res.send({ insertedId: result.insertedId })
    })

    app.get('/users/:email/role', async (req, res) => {
      const user = await userCollection.findOne({
        email: req.params.email,
      })
      res.send({ role: user?.role || 'user' })
    })

    app.get('/users/profile', verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded.email

        const user = await userCollection.findOne({ email })

        if (!user) {
          return res.status(404).send({ message: 'User not found' })
        }

        res.send(user)
      } catch (error) {
        console.error(error)
        res.status(500).send({ message: 'Failed to get profile' })
      }
    })
    app.patch(
      '/users/:id/role',
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id
        const { role } = req.body

        if (!['admin', 'user'].includes(role)) {
          return res.status(400).send({ message: 'Invalid role' })
        }

        try {
          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } },
          )
          res.send({ message: `User role updated to ${role}`, result })
        } catch (error) {
          console.error('❌ Error updating user role:', error)
          res.status(500).send({ message: 'Failed to update user role' })
        }
      },
    )

    app.get('/users/search', async (req, res) => {
      const emailQuery = req.query.email // <--- get email from query
      if (!emailQuery) {
        return res
          .status(400)
          .send({ message: 'Email query parameter is required' })
      }

      const regex = new RegExp(emailQuery, 'i')

      try {
        const users = await userCollection
          .find({ email: { $regex: regex } })
          .project({ email: 1, createdAt: 1, role: 1 })
          .limit(10)
          .toArray()
        res.send(users)
      } catch (error) {
        console.error('❌ Error searching users:', error)
        res.status(500).send({ message: 'Failed to search users' })
      }
    })

    app.get('/user/status-count', verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded.email

        const result = await parcelsCollection
          .aggregate([
            { $match: { email } },
            { $group: { _id: '$deliveryStatus', count: { $sum: 1 } } },
          ])
          .toArray()

        const statusCount = {
          created: 0,
          rider_assigned: 0,
          in_transit: 0,
          delivered: 0,
        }

        result.forEach((item) => {
          statusCount[item._id] = item.count
        })

        res.send(statusCount)
      } catch (error) {
        console.error(error)
        res.status(500).send({ message: 'Failed to get user stats' })
      }
    })

    // ---------------- PARCELS ROUTES ----------------
    app.post('/parcels', async (req, res) => {
      const parcel = req.body
      parcel.createdAt = new Date()
      if (!parcel.senderEmail && parcel.senderName && req.body.email) {
        parcel.senderEmail = req.body.email
      }

      const result = await parcelsCollection.insertOne(parcel)
      res.send(result)
    })

    app.get('/parcels', async (req, res) => {
      const { email, paymentStatus, deliveryStatus } = req.query
      const query = {}
      if (email) query.senderEmail = email
      if (paymentStatus) query.paymentStatus = paymentStatus
      if (deliveryStatus) query.deliveryStatus = deliveryStatus
      const result = await parcelsCollection.find(query).toArray()
      res.send(result)
    })

    app.get('/parcels/paid', async (req, res) => {
      const result = await parcelsCollection
        .find({ paymentStatus: 'paid' })
        .toArray()
      res.send(result)
    })

    app.get('/parcels/:id', async (req, res) => {
      const id = req.params.id

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: 'Invalid parcel ID' })
      }

      const parcel = await parcelsCollection.findOne({ _id: new ObjectId(id) })

      if (!parcel) {
        return res.status(404).send({ message: 'Parcel not found' })
      }

      res.send(parcel)
    })

    // app.patch('/parcels/pay/:id', async (req, res) => {
    //   try {
    //     const id = req.params.id
    //     if (!ObjectId.isValid(id))
    //       return res.status(400).send({ message: 'Invalid ID' })

    //     await updateParcelStatus(id, 'paid')
    //     await parcelsCollection.updateOne(
    //       { _id: new ObjectId(id) },
    //       { $set: { paymentStatus: 'paid' } },
    //     )

    //     res.send({ success: true })
    //   } catch (error) {
    //     res.status(500).send({ message: error.message })
    //   }
    // })

    app.get('/parcels', async (req, res) => {
      const { email, paymentStatus, deliveryStatus } = req.query

      const query = {}

      // Match your actual DB field
      if (email) query.senderEmail = email
      if (paymentStatus) query.paymentStatus = paymentStatus
      if (deliveryStatus) query.deliveryStatus = deliveryStatus

      const result = await parcelsCollection.find(query).toArray()
      res.send(result)
    })

    app.get('/parcels/paid', async (req, res) => {
      const result = await parcelsCollection
        .find({ paymentStatus: 'paid' })
        .toArray()
      res.send(result)
    })

    app.patch('/parcels/pay/:id', async (req, res) => {
      try {
        const id = req.params.id

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid ID' })
        }

        await updateParcelStatus(id, 'paid')

        await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { paymentStatus: 'paid' } },
        )

        res.send({ success: true })
      } catch (error) {
        res.status(500).send({ message: error.message })
      }
    })

    app.patch(
      '/parcels/assign-rider/:id',
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { riderEmail, riderName } = req.body

        if (!riderEmail || !riderName) {
          return res
            .status(400)
            .send({ success: false, message: 'Rider info required' })
        }

        try {
          const response = await updateParcelStatus(
            req.params.id,
            'rider_assigned', // this is deliveryStatus
            {
              assignedRiderEmail: riderEmail,
              assignedRiderName: riderName,
              parcelStatus: 'assigned',
              paymentStatus: 'paid',
            },
          )

          res.send({
            success: true,
            message: 'Rider assigned successfully',
            data: response,
          })
        } catch (err) {
          console.error(err)
          res.status(500).send({ success: false, message: err.message })
        }
      },
    )

    app.patch(
      '/parcels/pickup/:id',
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const response = await updateParcelStatus(req.params.id, 'picked_up')
          res.send(response)
        } catch (err) {
          res.status(404).send({ success: false, message: err.message })
        }
      },
    )

    app.patch(
      '/parcels/deliver/:id',
      verifyFBToken,
      verifyRider,
      async (req, res) => {
        try {
          const response = await updateParcelStatus(req.params.id, 'delivered')

          await parcelsCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            {
              $set: {
                deliveryStatus: 'delivered',
                deliveredAt: new Date(), // ✅ ADD THIS
              },
            },
          )

          res.send(response)
        } catch (err) {
          res.status(404).send({ success: false, message: err.message })
        }
      },
    )

    app.patch('/parcels/:id/status', async (req, res) => {
      const { id } = req.params
      const { deliveryStatus } = req.body

      // Validate ID
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: 'Invalid parcel ID' })
      }

      if (!deliveryStatus) {
        return res.status(400).send({ message: 'deliveryStatus is required' })
      }

      try {
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) }, // ✅ use correct variable
          {
            $set: { deliveryStatus }, // ✅ use the value sent from frontend
            $push: {
              history: { status: deliveryStatus, timestamp: new Date() },
            }, // optional: keep history
          },
        )

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: 'Parcel not found' })
        }

        res.send({ success: true, message: 'Parcel status updated', result })
      } catch (error) {
        console.error('❌ Failed to update parcel status:', error)
        res.status(500).send({ message: 'Failed to update parcel status' })
      }
    })

    app.get('/parcels/delivery/status-count', async (req, res) => {
      const pipeline = [
        {
          $group: {
            _id: '$deliveryStatus',
            count: {
              $sum: 1,
            },
          },
        },
        {
          $project: {
            status: '$_id',
            count: 1,
            _id: 0,
          },
        },
      ]

      const result = await parcelsCollection.aggregate(pipeline).toArray()

      res.send(result)
    })

    // ✅ parcel info
    app.get('/parcels/track/:trackingNumber', async (req, res) => {
      try {
        const trackingNumber = req.params.trackingNumber

        const parcel = await parcelsCollection.findOne({
          trackingNumber,
        })

        if (!parcel) {
          return res.status(404).send({ message: 'Parcel not found' })
        }

        res.send(parcel)
      } catch (error) {
        console.error(error)
        res.status(500).send({ message: error.message })
      }
    })
    // RIDER
    app.get('/riders', async (req, res) => {
      const { status } = req.query
      const query = {}

      if (status) {
        query.status = status
      }

      const riders = await ridersCollection.find(query).toArray()
      res.send(riders)
    })

    app.get('/riders/active', async (req, res) => {
      const { region } = req.query
      try {
        const riders = await ridersCollection
          .find({ status: 'approved', region })
          .toArray()
        res.send(riders)
      } catch (error) {
        console.error(error)
        res.status(500).send({ message: 'Failed to get active riders' })
      }
    })

    app.get('/rider/earnings', verifyFBToken, verifyRider, async (req, res) => {
      try {
        const email = req.query.email // the email sent from frontend

        // 🔹 SECURITY CHECK: make sure the requested email matches the logged-in user
        if (email !== req.decoded.email) {
          return res.status(403).send({ message: 'Forbidden' })
        }

        // 🔹 Fetch all delivered parcels assigned to this rider
        const result = await parcelsCollection
          .find({
            assignedRiderEmail: email,
            deliveryStatus: 'delivered',
          })
          .toArray()

        res.send(result)
      } catch (error) {
        console.error(error)
        res.status(500).send({ message: 'Failed to get earnings' })
      }
    })

    app.get('/rider/parcels', verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded.email

        if (!email) {
          return res.status(400).send({ message: 'Email is required' })
        }

        const query = {
          assignedRiderEmail: email,

          // ✅ Handle both cases safely
          $or: [
            { deliveryStatus: { $exists: false } }, // no status yet
            { deliveryStatus: { $ne: 'delivered' } }, // not delivered
          ],
        }

        const parcels = await parcelsCollection.find(query).toArray()

        res.send(parcels || []) // ✅ always send array
      } catch (error) {
        console.error(error)
        res.status(500).send({ message: 'Failed to get rider parcels' })
      }
    })

    app.get('/rider/parcels', verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded.email
        if (!email)
          return res.status(400).send({ message: 'Email is required' })

        // Only active parcels (not delivered)
        const query = {
          assignedRiderEmail: email,
          deliveryStatus: { $ne: 'delivered' }, // ❌ exclude delivered
        }

        const parcels = await parcelsCollection.find(query).toArray()
        res.send(parcels)
      } catch (error) {
        console.error(error)
        res.status(500).send({ message: 'Failed to get rider parcels' })
      }
    })
    app.post('/riders', async (req, res) => {
      const result = await ridersCollection.insertOne(req.body)
      res.send(result)
    })

    app.patch('/parcels/assign-rider/:id', async (req, res) => {
      try {
        const parcelId = req.params.id
        const { riderId, riderName, riderEmail } = req.body

        if (!riderId || !riderName || !riderEmail) {
          return res
            .status(400)
            .send({ success: false, message: 'Rider info is required' })
        }

        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              assignedRiderName: riderName,
              assignedRiderEmail: riderEmail,
              parcelStatus: 'assigned', // mark as assigned
            },
          },
        )

        if (updateResult.modifiedCount === 1) {
          res.send({ success: true, message: 'Rider assigned successfully!' })
        } else {
          res.send({ success: false, message: 'Failed to assign rider.' })
        }
      } catch (error) {
        console.error(error)
        res.status(500).send({ success: false, message: 'Server error' })
      }
    })

    app.patch('/riders/:id', async (req, res) => {
      try {
        const id = req.params.id
        const { status, email } = req.body

        const riderQuery = { _id: new ObjectId(id) }

        const riderUpdate = {
          $set: {
            status: status,
            email: email,
          },
        }

        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          riderUpdate,
        )

        // If rider approved → change user role
        if (status === 'approved') {
          await userCollection.updateOne({ email }, { $set: { role: 'rider' } })
        }

        res.send(riderResult)
      } catch (error) {
        res.status(500).send({ message: 'Failed to update rider status' })
      }
    })

    app.get('/riders/completed-parcels', async (req, res) => {
      try {
        const { email } = req.query

        const query = {
          deliveryStatus: 'delivered', // ✅ FIXED
        }

        if (email) {
          query.assignedRiderEmail = email // ✅ FIXED FIELD
        }

        const result = await parcelsCollection.find(query).toArray()

        res.send(result)
      } catch (error) {
        res.status(500).send({ message: 'Failed to get completed parcels' })
      }
    })

    app.get('/riders/status-count', async (req, res) => {
      try {
        const result = await parcelsCollection
          .aggregate([
            {
              $group: {
                _id: '$deliveryStatus', // use deliveryStatus instead of status
                count: { $sum: 1 },
              },
            },
          ])
          .toArray()

        // Ensure all keys exist
        const formatted = {
          assigned: 0,
          in_transit: 0,
          delivered: 0,
        }

        result.forEach((item) => {
          if (item._id === 'assigned') formatted.assigned = item.count
          if (item._id === 'in_transit') formatted.in_transit = item.count
          if (item._id === 'delivered') formatted.delivered = item.count
        })

        res.send(formatted)
      } catch (error) {
        console.error(error)
        res.status(500).send({ message: 'Error getting status counts' })
      }
    })
    // TRACKING
    app.post('/tracking', async (req, res) => {
      const log = { ...req.body, time: new Date() }
      const result = await trackingCollection.insertOne(log)
      res.send(result)
    })

    app.get('/tracking/:trackingId', async (req, res) => {
      const trackingId = req.params.trackingId

      const updates = await trackingCollection
        .find({ trackingId: trackingId })
        .sort({ time: 1 })
        .toArray()

      res.send(updates)
    })

    // PAYMENTS
    app.get('/payments', verifyFBToken, async (req, res) => {
      const email = req.decoded.email

      const payments = await paymentCollection.find({ email }).toArray()
      res.send(payments)
    })

    app.post('/payments', async (req, res) => {
      const { parcelId, email, amount } = req.body

      const existing = await paymentCollection.findOne({ parcelId })
      if (existing) {
        return res.send({ success: false, message: 'Already paid' })
      }

      await parcelsCollection.updateOne(
        { _id: new ObjectId(parcelId) },
        { $set: { paymentStatus: 'paid' } },
      )

      const result = await paymentCollection.insertOne({
        parcelId,
        email,
        amount,
        paid_at: new Date(),
      })

      res.send({ success: true, result })
    })

    // ---------------- STRIPE ----------------
    app.post('/create-payment-intent', async (req, res) => {
      try {
        const amount = Number(req.body.amountInCents)
        if (!amount || amount < 50)
          return res.status(400).send({ error: 'Invalid amount' })

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: 'usd',
        })

        console.log('🔥 create-payment-intent HIT')
        res.send({ clientSecret: paymentIntent.client_secret })
      } catch (error) {
        console.error('Stripe error:', error.message)
        res.status(500).send({ message: error.message })
      }
    })

    // ✅ Root route
    app.get('/', (req, res) => {
      res.send('🚀 Parcel server is running!')
    })

    // ✅ Start server AFTER routes are ready
    app.listen(port, () => {
      console.log(`🚀 Server running on ${port}`)
    })
  } catch (error) {
    console.error('❌ Error connecting to MongoDB:', error)
  }
}

run()
