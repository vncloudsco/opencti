import React, { Component } from 'react';
import * as PropTypes from 'prop-types';
import { createPaginationContainer } from 'react-relay';
import graphql from 'babel-plugin-relay/macro';
import { pathOr } from 'ramda';
import ListLinesContent from '../../../../components/list_lines/ListLinesContent';
import { SectorLine, SectorLineDummy } from './SectorLine';

const nbOfRowsToLoad = 25;

class SectorsLines extends Component {
  render() {
    const { initialLoading, dataColumns, relay } = this.props;
    return (
      <ListLinesContent
        initialLoading={initialLoading}
        loadMore={relay.loadMore.bind(this)}
        hasMore={relay.hasMore.bind(this)}
        isLoading={relay.isLoading.bind(this)}
        dataList={pathOr([], ['sectors', 'edges'], this.props.data)}
        globalCount={pathOr(
          nbOfRowsToLoad,
          ['sectors', 'pageInfo', 'globalCount'],
          this.props.data,
        )}
        LineComponent={<SectorLine />}
        DummyLineComponent={<SectorLineDummy />}
        dataColumns={dataColumns}
        nbOfRowsToLoad={nbOfRowsToLoad}
      />
    );
  }
}

SectorsLines.propTypes = {
  classes: PropTypes.object,
  paginationOptions: PropTypes.object,
  dataColumns: PropTypes.object.isRequired,
  data: PropTypes.object,
  relay: PropTypes.object,
  sectors: PropTypes.object,
  initialLoading: PropTypes.bool,
};

export const sectorsLinesQuery = graphql`
  query SectorsLinesPaginationQuery(
    $search: String
    $count: Int!
    $cursor: ID
    $orderBy: SectorsOrdering
    $orderMode: OrderingMode
  ) {
    ...SectorsLines_data
      @arguments(
        search: $search
        count: $count
        cursor: $cursor
        orderBy: $orderBy
        orderMode: $orderMode
      )
  }
`;

export default createPaginationContainer(
  SectorsLines,
  {
    data: graphql`
      fragment SectorsLines_data on Query
        @argumentDefinitions(
          search: { type: "String" }
          count: { type: "Int", defaultValue: 25 }
          cursor: { type: "ID" }
          orderBy: { type: "SectorsOrdering", defaultValue: "name" }
          orderMode: { type: "OrderingMode", defaultValue: "asc" }
        ) {
        sectors(
          search: $search
          first: $count
          after: $cursor
          orderBy: $orderBy
          orderMode: $orderMode
        ) @connection(key: "Pagination_sectors") {
          edges {
            node {
              id
              name
              description
              ...SectorLine_node
            }
          }
          pageInfo {
            endCursor
            hasNextPage
            globalCount
          }
        }
      }
    `,
  },
  {
    direction: 'forward',
    getConnectionFromProps(props) {
      return props.data && props.data.sectors;
    },
    getFragmentVariables(prevVars, totalCount) {
      return {
        ...prevVars,
        count: totalCount,
      };
    },
    getVariables(props, { count, cursor }, fragmentVariables) {
      return {
        search: fragmentVariables.search,
        count,
        cursor,
        orderBy: fragmentVariables.orderBy,
        orderMode: fragmentVariables.orderMode,
      };
    },
    query: sectorsLinesQuery,
  },
);