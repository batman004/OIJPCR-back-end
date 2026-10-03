/*
 * Stores `year` and `issue` on every Volume document.
 *
 *   node scripts/migrate-volume-bibliography.js            dry run (read-only, default)
 *   node scripts/migrate-volume-bibliography.js --apply    backs up volumes, then writes
 *
 * Only `year` and `issue` are set, and only where they are missing. Nothing is deleted.
 * The backup is written to backups/ before any write happens.
 */
const fs = require('fs')
const path = require('path')
require('dotenv').config({path: path.join(__dirname, '..', '.env')})
const mongoose = require('mongoose')
const Volume = require('../models/volume')
const {resolveIssue, resolveYear} = require('../utils/bibliography')

const apply = process.argv.includes('--apply')

async function main() {
    await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        useFindAndModify: false,
    })

    const volumes = await Volume.find({}).sort({volume: 1}).lean()
    const changes = volumes
        .map((doc) => ({
            _id: doc._id,
            volume: doc.volume,
            date: doc.date,
            before: {year: doc.year, issue: doc.issue},
            after: {year: resolveYear(doc), issue: resolveIssue(doc)},
        }))
        .filter(({before, after}) => before.year !== after.year || before.issue !== after.issue)

    console.log(`${volumes.length} volumes, ${changes.length} need year/issue`)
    changes.forEach(({volume, date, before, after}) =>
        console.log(
            `  volume ${String(volume).padStart(2)} date=${JSON.stringify(date)}  ` +
            `year ${before.year ?? '-'} -> ${after.year}, issue ${before.issue ?? '-'} -> ${after.issue}`,
        ))

    if (!apply) {
        console.log('\nDry run only. Re-run with --apply to write.')
        return
    }
    if (changes.length === 0) return

    const backupDir = path.join(__dirname, '..', 'backups')
    fs.mkdirSync(backupDir, {recursive: true})
    const backupFile = path.join(backupDir, `volumes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(backupFile, JSON.stringify(volumes, null, 2))
    console.log(`\nBackup written: ${backupFile}`)

    for (const {_id, after} of changes) {
        await Volume.updateOne({_id}, {$set: {year: after.year, issue: after.issue}})
    }
    console.log(`Updated ${changes.length} volumes.`)
}

main()
    .catch((err) => {
        console.error(err.message)
        process.exitCode = 1
    })
    .finally(() => mongoose.disconnect())
