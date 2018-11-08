"use strict";

const R = require('ramda')
    , { expandNS, getFirstObjectLiteral, makeSubgraphFrom } = require('./rdf')
    , { rdfListToArray, findOne } = require('org-n3-utils')

function fragmentOf(uri) {
  return (uri.value || uri.id).replace(/.*\/graph/, '')
}

function makeReadingsHTML(store, bib, readings) {
  const readingsHTML = readings.map(item => {
    let ret

    const bibID = item.value.split(':').slice(-1)[0]
        , bibItem = bib.get(bibID)

    if (!bibItem) {
      ret = `<p style="background-color: red;">Missing citation</p>`
    } else {
      ret = bibItem
        .split('\n').slice(1,-1).join('\n')
        .replace(/(https:\/\/doi.org\/(.*?))<\/div>/, (_, url, doi) =>
          `<a href="${url}">doi:${doi.replace(/(\W)+/g, '<wbr>$1</wbr>')}</a></div>`)

      if (ret.slice(-7) === '.</div>' && item['bibo:uri']) {
        ret = `${ret.slice(0, -6)} Retrieved from <a href="${item['bibo:uri']}">${item['bibo:uri']}</a>.</div>`
      }


    }

    return `${ret}`
  })

  return readingsHTML.join('')
}

const entityTypes = {
  People: {
    entityList: {
      author: expandNS('bibo:authorList'),
      editor: expandNS('bibo:editorList'),
    },
    uri: expandNS('foaf:Person'),
    label: (store, term) => ([
      getFirstObjectLiteral(store, term, 'foaf:givenname'),
      getFirstObjectLiteral(store, term, 'foaf:surname'),
    ]).filter(R.identity).join(' ')
  },
  Journals: {
    uri: expandNS('bibo:Journal'),
    label: (store, term) => getFirstObjectLiteral(store, term, 'dc:title'),
  },
  Conferences: {
    uri: expandNS('bibo:Conference'),
    label: (store, term) => getFirstObjectLiteral(store, term, 'dc:title'),
  },
  Publishers: {
    uri: expandNS(':Publisher'),
    label: (store, term) => getFirstObjectLiteral(store, term, 'foaf:name'),
  },
}

function getEntities(store) {
  const entities = []

  for (const [key, {entityList={}, uri, label}] of Object.entries(entityTypes)) {
    const entitiesForType = []
        , rolesForEntity = {}

    const seen = subj => entitiesForType.some(x => x.id === subj.id)

    Object.entries(entityList).forEach(([role, listPred]) => {
      store.getObjects(null, listPred).forEach(list => {
        rdfListToArray(store, list).forEach(subj => {
          if (!seen(subj)) {
            entitiesForType.push(subj)
          }
          rolesForEntity[subj.id] = (rolesForEntity[subj.id] || []).concat(role)
        })
      })
    })

    store.getSubjects(expandNS('rdf:type'), uri).forEach(subj => {
      if (!seen(subj)) {
        entitiesForType.push(subj)
      }
    })

    entitiesForType.forEach(subj => {
      entities.push({
        key,
        id: subj,
        label: label(store, subj),
        fragment: fragmentOf(subj),
        roles: [...new Set(rolesForEntity[subj.id] || [])]
      })
    })
  }

  return entities
}

function getMeetingTime(store, meetingURI) {
  try {
    const [ interval ] = store.getObjects(meetingURI, expandNS('lode:atTime'))
        , [ beginning ] = store.getObjects(interval, expandNS('time:hasBeginning'))
        , [ dateStamp ] = store.getObjects(beginning, expandNS('time:inXSDDateTimeStamp'))

    return dateStamp

  } catch (e) {
    throw new Error(
      `Triples for meeting time of ${meetingURI.value} are incorrectly defined.`
    )
  }
}

module.exports = async function getMeetings(store, bib) {
  const meetings = store
    .getObjects(null, expandNS(':meeting'))
    .map(meetingURI => {
      const [ schedule ] = store.getObjects(meetingURI, expandNS(':schedule'))

      return {
        meetingURI,
        at: getMeetingTime(store, meetingURI),
        schedule: rdfListToArray(store, schedule),
      }
    })

  return Promise.all(meetings.map(async meeting => {
    const { schedule, at } = meeting

    const html = R.pipe(
      R.groupWith((a, b) => a.termType === b.termType),
      R.transduce(
        R.map(list =>
          list[0].termType === 'NamedNode'
            ? makeReadingsHTML(store, bib, list)
            : list.map(R.pipe(
                bNode => findOne(store, bNode, expandNS('dc:description')),
                term => `<p>${term.object.value}</p>`
              )).join('\n')
        ),
        R.concat,
        '',
      )
    )(schedule)

    const meetingFragment = fragmentOf(meeting.meetingURI);

    const entities = await R.pipe(
      meetingURI => store.getObjects(meetingURI, expandNS('lode:involved')),
      makeSubgraphFrom(store),
      getEntities
    )(meeting.meetingURI)

    /*
    const entities = await R.pipe(
      involved => ({ '@graph': involved, '@context': context }),
      ld => R.map(({ frame, label }) =>
        jsonld.promises.frame(ld, Object.assign({ '@context': context }, frame))
          .then(data => data['@graph'].map(item => ({
            label: label(item),
            id: fragmentOf(item),
            externalLink: (item['foaf:homepage'] || item['foaf:workInfoHomepage'] || item['foaf:page'] || {})['@id'],
            meetingLink: 'archive.html#' + meetingFragment,
            ld: item,
          })))
      )(entityDefinitions),
      resolveObj
    )([].concat(meeting['lode:involved'] || []))
    */

    return {
      fragment: meetingFragment,
      date: new Date(at.value),
      entities,
      html,
    }
  }))
}
