const AppError = require('../utils/appError')
const Journal = require('../models/journal')
const Volume = require('../models/volume')
const {withArticleCounts} = require('../utils/volumes')

/**
 * @constructor
 * @param {request} request request-object
 * @param {response} response response-object
 * @return {response} response response-object
 */
exports.journals = async (request, response) => {
    const journals = await Journal
        .find({})
        .select('-content')
        .sort({createdAt: -1})
        .exec()
    response.status(200).json(journals)
}

exports.journalsByLimit = async (request, response) => {
    const {limit} = request.params

    if (isNaN(parseInt(limit, 10))) {
        throw new AppError('limit is not a valid number', 400)
    }

    const journals = await getJournals(parseInt(limit, 10))
    response.status(200).json(journals)
}

exports.journalsByVolume = async (request, response) => {
    const {volume, full} = request.params

    if (isNaN(parseInt(volume, 10))) {
        throw new AppError('Volume is not a valid number', 400)
    }

    let fieldsToRemove = '-content'
    if (full === 'full') {
        fieldsToRemove = ''
    }

    const journals = await Journal
        .find({'volume': volume})
        .select(fieldsToRemove)
        .sort({createdAt: -1})
    response.status(200).json(journals)
}

exports.getLimitedJournalsByVolume = async (request, response) => {
    const {volume, limit} = request.params

    const volumeInt = parseInt(volume, 10)
    if (isNaN(volumeInt) || volumeInt < 1) {
        throw new AppError('Volume is not a valid value', 400)
    }

    const numberOfArticles = parseInt(limit, 10)
    if (isNaN(numberOfArticles) || numberOfArticles < 1) {
        throw new AppError('Limit is not a valid value', 400)
    }

    const journals = await Journal
        .find({'volume': volume})
        .select('-content')
        .sort({createdAt: -1})
        .limit(numberOfArticles)
    response.status(200).json(journals)
}

exports.getJournal = async (req, res) => {
    const {id} = req.params
    const journal = await Journal.findById(id)

    if (!journal) {
        throw new AppError(`Found no journal with ID ${id}`, 404)
    }

    res.status(200).json(journal)
}

exports.archive = async (req, res) => {
    const archives = await Volume.find({}).sort({volume: 1})
    res.status(200).json(await withArticleCounts(archives))
}

exports.journalsByTag = async (req, res) => {
    const {tag} = req.params

    if (typeof tag !== 'string' || tag.length < 1) {
        throw new AppError(`Invalid tag: ${tag}`, 404)
    }

    const articles = await Journal.find({
        $text: {
            $search: tag,
        },
    }).select('-content')

    res.status(200).json(articles)
}

exports.tags = async (req, res) => {
    let tags = await Journal.distinct("tags")
    // tags = ["tag1, tag2, tag3", "tag4, tag5"]
    tags = tags.map(tag => tag.split(', '))
    // tags is a 2D array
    // tags = [["tag1", "tag2", "tag3"], ["tag4, tag5"]]
    // alternate solution - tags = tags.flat(1) ES2019 syntax
    tags = [].concat.apply([], tags)

    const max = 9
    const end = tags.length < max ? tags.length : max
    tags = tags.slice(0, end)
    res.status(200).json(tags)
}

async function getJournals(limit) {
    return await Journal
        .find({})
        .select('-content -authorPhoto')
        .sort({createdAt: -1})
        .limit(limit)
        .exec()
}
