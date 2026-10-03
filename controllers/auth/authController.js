const {promisify} = require('util')
const jwt = require('jsonwebtoken')
const User = require('../../models/user')
const AppError = require('../../utils/appError')
const {
    generatePasswordHash, createSendToken,
} = require('./utils')

require('dotenv').config()

exports.isLoggedIn = async (req, res, next) => {
    let token
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) token = req.headers.authorization.split(' ')[1]

    if (!token) throw new AppError('Please log in to access this resource', 401)

    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET)

    const currentUser = await User.findById(decoded.id)

    if (!currentUser) throw new AppError('This token is no longer valid', 401)
    // res.locals, not req.user: deleteUser checks req.user and must keep behaving as before.
    res.locals.user = currentUser
    return next()
}

exports.me = (req, res) => {
    res.status(200).json({username: res.locals.user.username})
}

exports.login = async (req, res) => {
    const {username, password} = req.body

    if (!(username && password)) throw new AppError('Please provide username and password', 400)

    const user = await User.findOne({username}).select('+password')

    if (!user || !(await user.matchPassword(password, user.password))) throw new AppError('Incorrect username or password', 401)

    createSendToken(user, 200, res)
}

exports.logout = (req, res) => {
    const bufferTime = 10 * 1000
    const cookieOptions = {
        expires: new Date(Date.now() + bufferTime,), httpOnly: true,
    }

    res.cookie('jwt', '', cookieOptions)
    res.status(200).json({status: 'success'})
}

exports.signup = async (req, res) => {
    const {username, password, key} = req.body

    if (!key || key !== process.env.SECRET) throw new AppError('Incorrect Key', 401)

    if (!(username && password)) throw new AppError('Please provide valid username and password', 400)

    const newUser = await createNewUser(username, password)

    if (!newUser) throw new AppError('Could not create user: ' + username, 500)

    createSendToken(newUser, 201, res)
}

exports.deleteUser = async (req, res) => {
    if (!req.user) throw new AppError('You need to be logged-in to do that', 401)

    const {_id: id} = req.user
    await User.findByIdAndDelete(id)
    res.status(204).json({status: 'success'})
}


async function createNewUser(username, password) {
    const hash = await generatePasswordHash(password)
    const newUser = {
        username: username, password: hash,
    }

    const user = new User(newUser)
    await user.save()
    return user
}

