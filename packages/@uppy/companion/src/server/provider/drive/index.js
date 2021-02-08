const Provider = require('../Provider')

const { callbackify } = require('util')
const request = require('request')
const Purest = require('purest')
const logger = require('../../logger')
const adapter = require('./adapter')
const { ProviderApiError, ProviderAuthError } = require('../error')
const DRIVE_FILE_FIELDS = 'kind,id,name,mimeType,ownedByMe,permissions(role,emailAddress),size,modifiedTime,iconLink,thumbnailLink,teamDriveId'
const DRIVE_FILES_FIELDS = `kind,nextPageToken,incompleteSearch,files(${DRIVE_FILE_FIELDS})`
// using wildcard to get all 'drive' fields because specifying fields seems no to work for the /drives endpoint
const SHARED_DRIVE_FIELDS = '*'

/**
 * Adapter for API https://developers.google.com/drive/api/v3/
 */
class Drive extends Provider {
  constructor (options) {
    super(options)
    this.authProvider = options.provider = Drive.authProvider
    options.alias = 'drive'
    options.version = 'v3'

    this.client = Purest({ request })(options)
    this.promiseClient = Purest({ request, promise: Promise })(options)
  }

  static get authProvider () {
    return 'google'
  }

  async _list (options) {
    const directory = options.directory || 'root'
    const query = options.query || {}

    const client = this.promiseClient
    const handleErrorResponse = this._error.bind(this)

    async function fetchSharedDrives () {
      try {
        const shouldListSharedDrives = directory === 'root' && !query.cursor
        if (!shouldListSharedDrives) return undefined

        const [resp] = await client
          .get('drives')
          .qs({ fields: SHARED_DRIVE_FIELDS })
          .auth(options.token)
          .request()

        if (resp.statusCode !== 200) throw handleErrorResponse(undefined, resp)
        return resp
      } catch (err) {
        logger.error(err, 'provider.drive.sharedDrive.error')
        throw err
      }
    }

    async function fetchFiles () {
      const where = {
        fields: DRIVE_FILES_FIELDS,
        pageToken: query.cursor,
        q: `'${directory}' in parents and trashed=false`,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true
      }

      try {
        const [resp] = await client
          .query()
          .get('files')
          .qs(where)
          .auth(options.token)
          .request()

        if (resp.statusCode !== 200) throw handleErrorResponse(undefined, resp)
        return resp
      } catch (err) {
        logger.error(err, 'provider.drive.list.error')
        throw err
      }
    }

    const [sharedDrives, filesResponse] = await Promise.all([fetchSharedDrives(), fetchFiles()])

    return this.adaptData(
      filesResponse.body,
      sharedDrives && sharedDrives.body,
      directory,
      query
    )
  }

  list (options, done) {
    // @ts-ignore
    callbackify(this._list.bind(this))(options, done)
  }

  stats ({ id, token }, done) {
    return this.client
      .query()
      .get(`files/${id}`)
      .qs({ fields: DRIVE_FILE_FIELDS, supportsAllDrives: true })
      .auth(token)
      .request(done)
  }

  _exportGsuiteFile (id, token, mimeType) {
    logger.info(`calling google file export for ${id} to ${mimeType}`, 'provider.drive.export')
    return this.client
      .query()
      .get(`files/${id}/export`)
      .qs({ supportsAllDrives: true, mimeType })
      .auth(token)
      .request()
  }

  _waitForFailedResponse (resp) {
    return new Promise((resolve, reject) => {
      let data = ''
      resp.on('data', (chunk) => {
        data += chunk
      }).on('end', () => {
        try {
          resolve(JSON.parse(data.toString()))
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  download ({ id, token }, onData) {
    this.stats({ id, token }, (err, _, body) => {
      if (err) {
        logger.error(err, 'provider.drive.download.stats.error')
        onData(err)
        return
      }

      let requestStream
      if (adapter.isGsuiteFile(body.mimeType)) {
        requestStream = this._exportGsuiteFile(id, token, adapter.getGsuiteExportType(body.mimeType))
      } else {
        requestStream = this.client
          .query()
          .get(`files/${id}`)
          .qs({ alt: 'media', supportsAllDrives: true })
          .auth(token)
          .request()
      }

      requestStream
        .on('response', (resp) => {
          if (resp.statusCode !== 200) {
            this._waitForFailedResponse(resp)
              .then((jsonResp) => {
                resp.body = jsonResp
                onData(this._error(null, resp))
              })
              .catch((err) => onData(this._error(err, resp)))
          } else {
            resp.on('data', (chunk) => onData(null, chunk))
          }
        })
        .on('end', () => onData(null, null))
        .on('error', (err) => {
          logger.error(err, 'provider.drive.download.error')
          onData(err)
        })
    })
  }

  thumbnail (_, done) {
    // not implementing this because a public thumbnail from googledrive will be used instead
    const err = new Error('call to thumbnail is not implemented')
    logger.error(err, 'provider.drive.thumbnail.error')
    return done(err)
  }

  size ({ id, token }, done) {
    return this.stats({ id, token }, (err, resp, body) => {
      if (err || resp.statusCode !== 200) {
        err = this._error(err, resp)
        logger.error(err, 'provider.drive.size.error')
        return done(err)
      }

      if (adapter.isGsuiteFile(body.mimeType)) {
        // Not all GSuite file sizes can be predetermined
        // also for files whose size can be predetermined,
        // the request to get it can be sometimes expesnive, depending
        // on the file size. So we default the size to the size export limit
        const maxExportFileSize = 10 * 1024 * 1024 // 10 MB
        done(null, maxExportFileSize)
      } else {
        done(null, parseInt(body.size))
      }
    })
  }

  logout ({ token }, done) {
    return this.client
      .get('https://accounts.google.com/o/oauth2/revoke')
      .qs({ token })
      .request((err, resp) => {
        if (err || resp.statusCode !== 200) {
          logger.error(err, 'provider.drive.logout.error')
          done(this._error(err, resp))
          return
        }
        done(null, { revoked: true })
      })
  }

  adaptData (res, sharedDrivesResp, directory, query) {
    const adaptItem = (item) => ({
      isFolder: adapter.isFolder(item),
      icon: adapter.getItemIcon(item),
      name: adapter.getItemName(item),
      mimeType: adapter.getMimeType(item),
      id: adapter.getItemId(item),
      thumbnail: adapter.getItemThumbnailUrl(item),
      requestPath: adapter.getItemRequestPath(item),
      modifiedDate: adapter.getItemModifiedDate(item),
      size: adapter.getItemSize(item),
      custom: {
        // @todo isTeamDrive is left for backward compatibility. We should remove it in the next
        // major release.
        isTeamDrive: adapter.isSharedDrive(item),
        isSharedDrive: adapter.isSharedDrive(item)
      }
    })

    const items = adapter.getItemSubList(res)
    const sharedDrives = sharedDrivesResp ? sharedDrivesResp.drives || [] : []

    const adaptedItems = sharedDrives.concat(items).map(adaptItem)

    return {
      username: adapter.getUsername(res),
      items: adaptedItems,
      nextPagePath: adapter.getNextPagePath(res, query, directory)
    }
  }

  _error (err, resp) {
    if (resp) {
      const fallbackMessage = `request to ${this.authProvider} returned ${resp.statusCode}`
      const errMsg = (resp.body && resp.body.error) ? resp.body.error.message : fallbackMessage
      return resp.statusCode === 401 ? new ProviderAuthError() : new ProviderApiError(errMsg, resp.statusCode)
    }
    return err
  }
}

module.exports = Drive
