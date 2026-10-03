const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '.env') })

const express = require('express')
require('express-async-errors')

const app = express().disable('x-powered-by')

const cors = require('cors')
const mongoose = require('mongoose')
const morgan = require('morgan')
const method_override = require('method-override')
const rateLimit = require('express-rate-limit')
const helmet = require('helmet')
const cookieParser = require('cookie-parser')
const AppError = require('./utils/appError')
const globalErrorHandler = require('./controllers/errorController')
// Routes
const journalsRoute = require('./routes/journals')
const adminRoute = require('./routes/admin')
const editorRoute = require('./routes/editor')
const volumeRoute = require('./routes/volume')
const unhandledExceptionListener = require('./utils/unhandledExceptionListener')

process.on('uncaughtException', err => {
    unhandledExceptionListener('UNHANDLED EXCEPTION', err)
})


let mongoConnectionString, whitelist

if (process.env.NODE_ENV === 'dev') {
    app.use(morgan('dev'))
    mongoConnectionString = 'mongodb://localhost/oijpcr'
    whitelist = process.env.DEV_WHITELIST
} else {
    app.use(morgan('tiny'))
    mongoConnectionString = process.env.MONGO_URI
    whitelist = process.env.WHITELIST
}


function allowedOrigins() {
    return String(whitelist || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean)
}

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || allowedOrigins().includes(origin)) {
            return callback(null, true)
        }
        callback(new AppError("Blocked by CORS", 403))
    }
}

app.use(helmet({
    contentSecurityPolicy: false,
}),)

// CORS
app.use(cors({
    credentials: true, origin: corsOptions
}))

const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 1000, message: 'Too many requests, try again later',
})

app.use('*', limiter)
app.use(method_override('_method'))
app.use(cookieParser())
app.use(express.urlencoded({ limit: '5mb', extended: true }))
app.use(express.json({ limit: '5mb' }))


const mongoOptions = {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
    useFindAndModify: false,
}

mongoose.connect(mongoConnectionString, mongoOptions)
    .then(() => {
        console.log('Connected to MongoDB: OIJPCR 🐦 🐦 🐦')
    })
    .catch(err => {
        throw new Error(`Error Message: ${err.message}`)
    })


app.use(function (req, res, next) {
    const origin = req.headers.origin
    if (origin && allowedOrigins().includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin)
    }
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, X-PINGOTHER,Content-Type, Accept, Authorization');
    next();
});


app.use('/journals', journalsRoute)
app.use('/admin', adminRoute)
app.use('/volume', volumeRoute)
app.use('/editor', editorRoute)

// 404 page
app.get('*', (req, res) => {
    res.status(404).send('<h1>404 Page Not Found</h1>')
})

// catch all
app.all('*', (req, res, next) => {
    next(new AppError(`${req.originalUrl} not found`, 404))
})

// Error handler middleware
app.use(globalErrorHandler)

module.exports = app
